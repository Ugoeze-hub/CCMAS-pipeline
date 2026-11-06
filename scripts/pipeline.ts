/**
 * CCMAS pipeline: NUC page -> PDFs -> text -> courses -> ccmas/data/<discipline>.json
 *
 *   node ccmas/scripts/pipeline.ts                        all 17 disciplines; PDFs fetched to temp and deleted
 *   node ccmas/scripts/pipeline.ts --only computing       one discipline (substring of the PDF filename)
 *   node ccmas/scripts/pipeline.ts --cache --dump-text    keep PDFs + extracted text in ccmas/pdfs/ (gitignored)
 *
 * Needs `pdftotext` (poppler; ships with Git for Windows) on PATH. No npm packages.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CCMAS_URL = "https://www.nuc.edu.ng/ccmas/";
const USER_AGENT = "Mozilla/5.0 (ccmas-pipeline)";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // ccmas/
const PDF_DIR = join(ROOT, "pdfs");
const DATA_DIR = join(ROOT, "data");

export interface Course {
  code: string;
  title: string;
  units: number;
  status: string | null; // C = compulsory, E = elective, R = required
  lh: number | null; // lecture hours
  ph: number | null; // practical hours
  page: number; // 1-based PDF page, for #page= links
  level: number;
  outcomes_intro: string | null;
  outcomes: string[];
  contents: string;
  lab_work: string | null;
}

export interface Programme {
  name: string;
  degree: string;
  start_page: number;
  end_page: number;
  courses: Course[];
}

export interface Discipline {
  discipline: string;
  slug: string;
  source_url: string;
  text_quality: { pages: number; words: number; near_empty_pages: number };
  programmes: Programme[];
}

// ---------------------------------------------------------------- 1. scrape

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function scrapePdfLinks(pageUrl = CCMAS_URL): Promise<string[]> {
  const html = (await fetchBytes(pageUrl)).toString("utf8");
  const links = [...html.matchAll(/href="([^"]+\.pdf)"/gi)].map((m) => m[1]);
  return [...new Set(links)].sort();
}

// Filename noise to strip when turning a PDF name into a discipline name/slug.
const NAME_NOISE = /-(CCMAS|FINAL|New|ALL|A|20\d\d|December|\d{1,2})(?=-|$)/gi;

/** '.../Engineering-Technology-CCMAS-2023-FINAL.pdf' -> ['Engineering Technology', 'engineering-technology'] */
export function disciplineFromUrl(url: string): [string, string] {
  let stem = basename(url, ".pdf");
  let prev = "";
  while (prev !== stem) {
    prev = stem;
    stem = stem.replace(NAME_NOISE, ""); // repeat: noise tokens can be adjacent
  }
  return [stem.replaceAll("-", " "), stem.toLowerCase()];
}

// ---------------------------------------------------------------- 2. fetch

/** Path to the PDF, plus a cleanup function (removes the temp copy when not caching). */
async function getPdf(url: string, cache: boolean): Promise<[string, () => void]> {
  const cached = join(PDF_DIR, basename(url));
  if (existsSync(cached)) return [cached, () => {}];
  const data = await fetchBytes(url);
  if (cache) {
    mkdirSync(PDF_DIR, { recursive: true });
    writeFileSync(cached, data);
    return [cached, () => {}];
  }
  const dir = mkdtempSync(join(tmpdir(), "ccmas-"));
  const tmp = join(dir, basename(url));
  writeFileSync(tmp, data);
  return [tmp, () => rmSync(dir, { recursive: true, force: true })];
}

// ---------------------------------------------------------------- 3. extract

/** Text of each PDF page (index 0 = PDF page 1), layout preserved. */
export function extractPages(pdf: string): string[] {
  const out = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", pdf, "-"], {
    maxBuffer: 512 * 1024 * 1024,
  }).toString("utf8");
  const pages = out.split("\f");
  if (pages.length && !pages.at(-1)!.trim()) pages.pop(); // trailing form feed
  return pages;
}

function textQuality(pages: string[]) {
  const words = pages.map((p) => p.split(/\s+/).filter(Boolean).length);
  return {
    pages: pages.length,
    words: words.reduce((a, b) => a + b, 0),
    near_empty_pages: words.filter((w) => w < 20).length,
  };
}

// ---------------------------------------------------------------- 4. parse

// Programme lines in the table of contents, e.g. "B.Sc. Computer Science ........ 27"
const TOC_LINE = /^\s*(B\.\s?[A-Za-z.]+\s.+?)\s*\.{3,}\s*(\d+)\s*$/gm;
// Course heading start: "COS 101: Introduction to ..." (3 code letters + 3 digits)
const HEADING_START = /^\s*([A-Z]{3})\s?(\d{3})\s*[:\-–]?\s*(\S.*)$/;
// Tail of a heading: "Introduction to Computing Sciences (3 Units C: LH 30; PH 45)"
const HEADING_TAIL = /^(?<title>.+?)\s*\(\s*(?<units>\d+)\s*Units?\b(?<rest>[^)]*)\)?\s*$/i;
const STATUS = /\b([CER])\d?\b/; // tolerates typos like "C1:"
const HOURS = /\b(LH|PH)\s*[:=]?\s*(\d+)/gi;
const UNITS_OPEN = /\(\s*\d+\s*Units?/i;

const SECTION_MARKERS: [keyof Sections, RegExp][] = [
  ["outcomes", /^\s*Learning\s+Outcomes?\b:?/i],
  ["contents", /^\s*Course\s+Contents?\b:?/i],
  ["lab", /^\s*Lab(oratory)?\s+Work\b:?/i],
];
interface Sections {
  outcomes: string[];
  contents: string[];
  lab: string[];
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Most common (pdf index - printed page number), read from footers like 'Computing 35 New'. */
function tocToPdfOffset(pages: string[]): number {
  const counts = new Map<number, number>();
  pages.forEach((page, idx) => {
    const lines = page.split("\n").filter((l) => l.trim());
    for (const line of lines.slice(-3).reverse()) {
      const m = line.match(/(?:^|\s)(\d{1,4})(?:\s+\w+)?\s*$/);
      if (m && line.trim().split(/\s+/).length <= 4) {
        const d = idx - Number(m[1]);
        counts.set(d, (counts.get(d) ?? 0) + 1);
        break;
      }
    }
  });
  let best = 0;
  let bestCount = 0;
  for (const [d, c] of counts) if (c > bestCount) [best, bestCount] = [d, c];
  return best;
}

/** [programme name, printed start page] from the table of contents in the first pages. */
export function parseToc(pages: string[], searchPages = 30): [string, number][] {
  const seen = new Set<string>();
  const out: [string, number][] = [];
  for (const page of pages.slice(0, searchPages)) {
    for (const m of page.matchAll(TOC_LINE)) {
      const name = squash(m[1]);
      if (!seen.has(name)) {
        seen.add(name);
        out.push([name, Number(m[2])]);
      }
    }
  }
  return out;
}

/** Running footers such as 'Computing 35 New' or a bare page number. */
function isFooter(line: string): boolean {
  const s = squash(line); // layout mode pads footers with wide gaps
  return s.length < 60 &&/^(?:[A-Za-z&,]+\s+){0,4}\d{1,4}(?:\s+New)?$/.test(s);
}

const cleanLines = (page: string) => page.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !isFooter(l));

type Line = [page: number, text: string];
type Heading = Omit<Course, "outcomes_intro" | "outcomes" | "contents" | "lab_work">;

/** Course headings in the lines, joining headings that wrap onto the next line.
 *  Returns [index of the heading's first line, index where its body starts, heading]. */
export function findHeadings(lines: Line[]): [number, number, Heading][] {
  const out: [number, number, Heading][] = [];
  let i = 0;
  while (i < lines.length) {
    const [page, line] = lines[i];
    const m = line.match(HEADING_START);
    if (m) {
      let tail = m[3].trim();
      let consumed = 1;
      const next = lines[i + 1]?.[1].trim();
      if (!/unit/i.test(tail) && next && UNITS_OPEN.test(next)) {
        tail += " " + next; // "(2 Units ...)" starts on the next line
        consumed = 2;
      } else if (/unit/i.test(tail) && !tail.split("(").at(-1)!.includes(")") && next && next.length < 40 && next.includes(")")) {
        tail += " " + next; // "(2 Units" here, ")" below
        consumed = 2;
      }
      const t = squash(tail).match(HEADING_TAIL);
      if (t?.groups) {
        const rest = t.groups.rest;
        const hours: Record<string, number> = {};
        for (const [, k, v] of rest.matchAll(HOURS)) hours[k.toUpperCase()] = Number(v);
        out.push([i, i + consumed, {
          code: `${m[1]} ${m[2]}`,
          title: t.groups.title.replace(/^[\s:\-–]+|[\s:\-–]+$/g, ""),
          units: Number(t.groups.units),
          status: rest.match(STATUS)?.[1] ?? null,
          lh: hours.LH ?? null,
          ph: hours.PH ?? null,
          page: page + 1,
          level: Number(m[2][0]) * 100,
        }]);
        i += consumed;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** Numbered list ('1. explain ...') -> items, with wrapped lines joined. */
function splitOutcomes(lines: string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const s = line.trim();
    const m = s.match(/^(\d{1,2})[.)]\s+(.*)$/);
    if (m) items.push(m[2]);
    else if (items.length) items[items.length - 1] += " " + s;
    else items.push(s); // preamble: "At the end of the course, students should be able to:"
  }
  return items.map(squash).filter(Boolean);
}

function parseCourseBody(body: string[]) {
  const sections: Sections = { outcomes: [], contents: [], lab: [] };
  const before: string[] = []; // text before any section header (e.g. SIWES descriptions)
  let current: keyof Sections | null = null;
  for (let line of body) {
    for (const [key, marker] of SECTION_MARKERS) {
      const m = line.match(marker);
      if (m) {
        current = key;
        line = line.slice(m[0].length);
        break;
      }
    }
    if (line.trim()) (current ? sections[current] : before).push(line);
  }
  if (!sections.contents.length) sections.contents = before;
  const outcomes = splitOutcomes(sections.outcomes);
  const intro = outcomes.length && outcomes[0].endsWith(":") ? outcomes.shift()! : null;
  return {
    outcomes_intro: intro,
    outcomes,
    contents: squash(sections.contents.join(" ")),
    lab_work: squash(sections.lab.join(" ")) || null,
  };
}

export function parseProgrammes(pages: string[]): Programme[] {
  const toc = parseToc(pages);
  const offset = tocToPdfOffset(pages);
  return toc.map(([name, printedStart], n) => {
    const start = printedStart + offset;
    const end = Math.min(n + 1 < toc.length ? toc[n + 1][1] + offset : pages.length, pages.length);
    const lines: Line[] = [];
    for (let p = start; p < end; p++) for (const l of cleanLines(pages[p])) lines.push([p, l]);
    const headings = findHeadings(lines);
    const courses = headings.map(([, bodyStart, info], h) => {
      const bodyEnd = h + 1 < headings.length ? headings[h + 1][0] : lines.length;
      return { ...info, ...parseCourseBody(lines.slice(bodyStart, bodyEnd).map(([, l]) => l)) };
    });
    return { name, degree: name.split(" ")[0], start_page: start + 1, end_page: end, courses };
  });
}

// ---------------------------------------------------------------- 5. run

async function runOne(url: string, cache: boolean, dumpText: boolean): Promise<Discipline> {
  const [name, slug] = disciplineFromUrl(url);
  const [pdf, cleanup] = await getPdf(url, cache);
  let pages: string[];
  try {
    pages = extractPages(pdf);
  } finally {
    cleanup();
  }
  if (dumpText) {
    mkdirSync(PDF_DIR, { recursive: true });
    writeFileSync(join(PDF_DIR, basename(url, ".pdf") + ".txt"), pages.join("\f"), "utf8");
  }
  const result: Discipline = {
    discipline: name,
    slug,
    source_url: url,
    text_quality: textQuality(pages),
    programmes: parseProgrammes(pages),
  };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, `${slug}.json`), JSON.stringify(result, null, 2), "utf8");
  const q = result.text_quality;
  const nCourses = result.programmes.reduce((a, p) => a + p.courses.length, 0);
  console.log(`${name}: ${q.pages} pages, ${q.words} words, ${q.near_empty_pages} near-empty | ` +
    `${result.programmes.length} programmes, ${nCourses} courses`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args[onlyIdx + 1]?.toLowerCase() : undefined;
  let links = await scrapePdfLinks();
  if (only) links = links.filter((u) => basename(u).toLowerCase().includes(only));
  console.log(`${links.length} PDF(s) to process`);
  for (const url of links) {
    try {
      await runOne(url, args.includes("--cache"), args.includes("--dump-text"));
    } catch (err) {
      console.log(`FAILED ${basename(url)}: ${(err as Error).message}`); // one bad PDF shouldn't stop the rest
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
