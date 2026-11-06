/**
 * CCMAS pipeline: NUC page -> PDFs -> text -> courses -> data/<discipline>.json
 *
 *   npm run pipeline                                      all 17 disciplines; PDFs fetched to temp and deleted
 *   npm run pipeline -- --only computing                  one discipline (substring of the PDF filename)
 *   npm run pipeline -- --cache --dump-text               keep PDFs + extracted text in pdfs/ (gitignored)
 *
 * Needs `pdftotext` (poppler; ships with Git for Windows) on PATH. No npm packages.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CCMAS_URL = "https://www.nuc.edu.ng/ccmas/";
const USER_AGENT = "Mozilla/5.0 (ccmas-pipeline)";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // repo root
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
  prerequisites: string | null;
  outcomes_intro: string | null;
  outcomes: string[];
  contents: string;
  lab_work: string | null;
}

export interface Programme {
  name: string; // cleaned department name, e.g. "Computer Science"
  degree: string; // normalised, e.g. "B.Sc."
  toc_name: string; // as printed in the PDF's table of contents
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
// Any TOC entry: "Name .......... 27" or "Name ------------ 21" (Medicine uses dashes, sometimes with gaps)
const TOC_ENTRY = /^\s*(\S.*?)\s*(?:[.\-–]\s*){3,}(\d+)\s*$/gm;
// Course heading start: "COS 101: Introduction to ..." (3 code letters + 3 digits)
const HEADING_START = /^\s*([A-Z]{3})\s?(\d{3})\s*[:\-–]?\s*(\S.*)$/;
// Tail of a heading, after the code. Seen in the PDFs:
//   "Introduction to Computing Sciences (3 Units C: LH 30; PH 45)"
//   "Agricultural Marketing (2 Units C) (LH 15; PH 45)"      "Two-Dimensional Art (2 Units; C) (LH 90)"
//   "Metric Space Topology (2 Units C: LH 30) Pre-requisite –MTH 202."   (text after the heading)
//   "New Testament (2 UnitsC: LH 30)"   "Nigerian Peoples and Culture (2 Unite C: LH 30)"
const HEADING_TAIL =
  /^(?<title>.+?)\s*\(\s*(?<units>\d+)\s*Unit[se]?s?(?<rest>[^)]*)(?:\)|$)\s*(?:\((?<rest2>[^)]*\b[LP]H\b[^)]*)(?:\)|$))?\s*(?<after>.*)$/i;
const UNITS = /\(\s*\d+\s*Unit/i;
const STATUS = /\b([CER])\d?\b/; // tolerates typos like "C1:"
const HOURS = /\b(LH|PH)\s*[:=]?\s*(\d+)/gi;
// Lines that end a heading's title wrap: table rows ("CRD 307   Field Admin…   3   C") and totals.
const TABLE_ROW = /\s{3,}\d+(?:\s|$)|\s{3,}[CER]\b|^\s*Total\b/i;
// Section headings that bound each programme's course descriptions
const CCLO_HEADING = /^\s*Courses?\s+Contents?,?\s+and\s+Learning\s+Outcomes?\s*:?\s*$/i;
const GCS_HEADING = /^\s*Global\s+Course\s+Structures?\s*:?\s*$/i;
const MAS_HEADING = /^\s*Minimum\s+Academic\s+Standards?\s*\.?\s*$/i;

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

/** [programme name, printed start page] from the table of contents in the first pages.
 *  A programme is the TOC entry right before an "Overview" entry (works for B.Sc., LL.B, MBBS, DVM, Pharm.D …);
 *  its start page is taken from the Overview line, since some programme lines have typos ("1646" for 164).
 *  Falls back to names starting "B." when a TOC has no Overview entries (TOC_LINE). */
export function parseToc(pages: string[], searchPages = 30): [string, number][] {
  const entries: [string, number][] = [];
  for (const page of pages.slice(0, searchPages)) {
    for (const m of page.matchAll(TOC_ENTRY)) entries.push([squash(m[1]), Number(m[2])]);
  }
  const seen = new Set<string>();
  const out: [string, number][] = [];
  const add = (name: string, page: number) => {
    if (!seen.has(name)) {
      seen.add(name);
      out.push([name, page]);
    }
  };
  entries.forEach(([name, page], i) => {
    const next = entries[i + 1];
    if (next && /^overview\b/i.test(next[0]) && !/^overview\b/i.test(name)) add(name, next[1]);
  });
  // Last programme in Education's TOC has no Overview line under it
  const last = entries.at(-1);
  if (out.length && last && /^B\.\s?[A-Za-z.]+\s/.test(last[0]) && last[1] > out.at(-1)![1]) add(...last);
  if (!out.length) for (const page of pages.slice(0, searchPages)) for (const m of page.matchAll(TOC_LINE)) add(squash(m[1]), Number(m[2]));
  return out;
}

/** Running footers such as 'Computing 35 New' or a bare page number. */
function isFooter(line: string): boolean {
  const s = squash(line); // layout mode pads footers with wide gaps
  return s.length < 60 &&/^(?:[A-Za-z&,]+\s+){0,4}\d{1,4}(?:\s+New)?$/.test(s);
}

const cleanLines = (page: string) => page.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !isFooter(l));

type Line = [page: number, text: string];
type Heading = Omit<Course, "prerequisites" | "outcomes_intro" | "outcomes" | "contents" | "lab_work">;

/** True while the heading text still needs the next line: no "(N Units" yet, or a parenthesis left open. */
function headingIncomplete(text: string): boolean {
  const u = text.search(UNITS);
  if (u < 0) return true;
  const fromUnits = text.slice(u);
  return (fromUnits.match(/\(/g) ?? []).length > (fromUnits.match(/\)/g) ?? []).length;
}

/** Course headings in the lines, joining headings that wrap over up to 4 lines
 *  ("…Rural Sociology (3" / "Units; C) (LH 45)", or a long title before "(2 Units C: LH 30)").
 *  Returns [index of the heading's first line, index where its body starts, heading, text after the heading]. */
export function findHeadings(lines: Line[]): [number, number, Heading, string][] {
  const out: [number, number, Heading, string][] = [];
  let i = 0;
  while (i < lines.length) {
    const [page, line] = lines[i];
    const m = line.match(HEADING_START);
    if (m && !(TABLE_ROW.test(line) && !UNITS.test(line))) {
      let tail = m[3].trim();
      let consumed = 1;
      while (consumed < 4 && headingIncomplete(tail)) {
        const next = lines[i + consumed]?.[1];
        if (!next || HEADING_START.test(next) || TABLE_ROW.test(next) && !UNITS.test(next)) break;
        if (SECTION_MARKERS.some(([, re]) => re.test(next))) break;
        if (!UNITS.test(tail) && !UNITS.test(next) && next.trim().length > 90) break; // a paragraph, not a title wrap
        tail += " " + next.trim();
        consumed++;
      }
      const t = UNITS.test(tail) ? squash(tail).match(HEADING_TAIL) : null;
      if (t?.groups) {
        const rest = t.groups.rest + " " + (t.groups.rest2 ?? "");
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
        }, t.groups.after]);
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

function parseCourseBody(rawBody: string[]) {
  const sections: Sections = { outcomes: [], contents: [], lab: [] };
  const before: string[] = []; // text before any section header (e.g. SIWES descriptions, prerequisites)
  let current: keyof Sections | null = null;
  // Rejoin section markers split over two lines ("… LH 30) Learning" / "outcomes")
  const body: string[] = [];
  for (const line of rawBody) {
    const prev = body.at(-1);
    if (prev !== undefined && /^\s*(Learning|Course)\s*$/i.test(prev) && /^\s*(Outcomes?|Contents?)\b/i.test(line)) body[body.length - 1] = prev.trim() + " " + line.trim();
    else body.push(line);
  }
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
  let prerequisites: string | null = null;
  const pre = squash(before.join(" ")).match(/^Pre-?\s?requisites?\s*[:\-–]*\s*(.+)$/i);
  if (pre) {
    prerequisites = pre[1].replace(/\.$/, "");
    before.length = 0;
  }
  if (!sections.contents.length) sections.contents = before;
  const outcomes = splitOutcomes(sections.outcomes);
  const intro = outcomes.length && outcomes[0].endsWith(":") ? outcomes.shift()! : null;
  return {
    prerequisites,
    outcomes_intro: intro,
    outcomes,
    contents: squash(sections.contents.join(" ")),
    lab_work: squash(sections.lab.join(" ")) || null,
  };
}

/** 'B. Sc / B. Tech. Estate management' -> { degree: 'B.Sc./B.Tech.', name: 'Estate Management' }.
 *  TOC names are inconsistent (B. Sc. / B.SC / BSc, 'LL. B Degree', 'Bachelor of … (MBBS/MBChB)'). */
export function splitProgrammeName(raw: string): { degree: string; name: string } {
  let s = raw
    .replace(/^B\. Technology Education$/, "B.Tech. Technology Education")
    .replace(/^B\. Agriculture$/, "B.Agric. Agriculture")
    .replace(/\b(Ed\.)(?=[A-Za-z])/, "$1 ")
    .replace(/\b([A-Z])\.\s+(?=(?:Sc|SC|Tech|A|Ed|N)\b)/g, "$1.") // "B. Sc" -> "B.Sc"
    .replace(/\s*\/\s*\.?\s*/g, "/"); // "B. Sc./. B. Tech" -> "B.Sc./B.Tech"
  let degree: string;
  let name: string;
  const paren = s.match(/^((?:Bachelor|Doctor) of .+?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    degree = paren[2];
    name = paren[1].replace(/^Bachelor of Medicine and Bachelor of Surgery$/, "Medicine and Surgery").replace(/^(?:Bachelor|Doctor) of /, "");
  } else if (/^LL\.?\s?B\b/.test(s)) {
    degree = "LL.B";
    name = s.replace(/^LL\.?\s?B\.?\s*/, "").replace(/^Degree$/, "Law");
  } else {
    const tokens = s.split(/\s+/);
    let i = 0;
    while (i < tokens.length - 1) {
      const t = tokens[i];
      const abbrev = (p: string) => p.includes(".") || /^[A-Z]{2,5}$/.test(p);
      const degreeish = (t.includes("/") ? t.split("/").filter(Boolean).every(abbrev) : t.includes(".")) ||/^\(?Ed\)?$|^BSc$/i.test(t) || (i > 0 && /^[A-Z]{2,4}$/.test(t) && tokens[i - 1].endsWith("."));
      if (!degreeish || t.length > (t.includes("/") ? 20 : 9)) break;
      i++;
    }
    degree = tokens.slice(0, i).join("");
    name = tokens.slice(i).join(" ");
  }
  degree = degree
    .replace(/\s+/g, "")
    .replace(/SC/g, "Sc")
    .replace(/^BSc/, "B.Sc")
    .replace(/\/\.+/g, "/")
    .replace(/\b(B\.Sc|B\.A|B\.Tech|B\.Eng|B\.Ed|B\.Aud|Sc|Tech|Ed)(?=$|\/|\()/g, "$1.")
    .replace(/\.(?=\()/, ". ");
  name = name.replace(/\bB\.A\s*\(/, "(").replace(/^-+|\s+-in-\s+/g, (m) => (m.trim() === "-in-" ? " in " : ""));
  if (name === name.toUpperCase()) name = name.toLowerCase();
  name = name.replace(/(^|[\s/(-])([a-z])/g, (_, p, c) => p + c.toUpperCase()).replace(/\b(And|Of|In|With|The)\b/g, (w) => w.toLowerCase());
  return { degree, name };
}

export function parseProgrammes(pages: string[]): Programme[] {
  const toc = parseToc(pages);
  const offset = tocToPdfOffset(pages);
  // TOC page numbers drift (Arts is ~14 pages off by Classics), so anchor each programme on the page of its
  // own "Overview" heading: in order when there is one per programme, else the nearest to the TOC estimate.
  const overviewPages = pages.flatMap((p, i) => (/^\s*Overview\s*:?\s*$/im.test(p) ? [i] : []));
  const starts: number[] = [];
  toc.forEach(([, printed], n) => {
    const estimate = printed + offset;
    if (overviewPages.length === toc.length) starts.push(overviewPages[n]);
    else {
      const after = overviewPages.filter((p) => p > (starts.at(-1) ?? -1));
      const best = after.sort((a, b) => Math.abs(a - estimate) - Math.abs(b - estimate))[0];
      starts.push(best !== undefined && Math.abs(best - estimate) <= 30 ? best : estimate);
    }
  });
  return toc.map(([name], n) => {
    const start = starts[n];
    // Include the next programme's first page: programmes can share a page. The section bounds below keep
    // each programme to its own courses.
    const end = Math.min(n + 1 < toc.length ? starts[n + 1] + 1 : pages.length, pages.length);
    const lines: Line[] = [];
    for (let p = start; p < end; p++) for (const l of cleanLines(pages[p])) lines.push([p, l]);
    // Courses live between "Course Contents and Learning Outcomes" (else "Global Course Structure") and the
    // next "Minimum Academic Standards" heading (staffing, equipment, … – not part of any course).
    const find = (re: RegExp, from = 0) => {
      const i = lines.findIndex(([, l], idx) => idx >= from && re.test(l));
      return i < 0 ? null : i;
    };
    const linesStart = find(CCLO_HEADING) ?? find(GCS_HEADING) ?? 0;
    const linesEnd = find(MAS_HEADING, linesStart + 1) ?? lines.length;
    const headings = findHeadings(lines.slice(0, linesEnd)).filter(([idx]) => idx > linesStart || linesStart === 0);
    const courses = headings.map(([, bodyStart, info, after], h) => {
      const bodyEnd = h + 1 < headings.length ? headings[h + 1][0] : linesEnd;
      const body = lines.slice(bodyStart, bodyEnd).map(([, l]) => l);
      return { ...info, ...parseCourseBody(after ? [after, ...body] : body) };
    });
    return { ...splitProgrammeName(name), toc_name: name, start_page: start + 1, end_page: end, courses };
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
  writeIndex();
}

/** data/index.json: faculties and their programmes, so the page can list them without loading every file. */
export function writeIndex() {
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json") && f !== "index.json");
  const index = files.map((f) => {
    const d: Discipline = JSON.parse(readFileSync(join(DATA_DIR, f), "utf8"));
    return {
      discipline: d.discipline,
      slug: d.slug,
      source_url: d.source_url,
      programmes: d.programmes.map((p) => ({ name: p.name, degree: p.degree, courses: p.courses.length })),
    };
  });
  writeFileSync(join(DATA_DIR, "index.json"), JSON.stringify(index, null, 2), "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
