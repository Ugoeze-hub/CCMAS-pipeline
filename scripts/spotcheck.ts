/**
 * Sanity-check a parsed discipline: flag courses with missing parts and print samples to compare with the PDF.
 *
 *   npm run spotcheck -- computing           problems + one sample course per programme
 *   npm run spotcheck -- computing "COS 101"  show specific course(s) in every programme
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Course, Discipline } from "./pipeline.ts";

const DATA_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "data");
const SHARED = new Set(["GST", "MTH", "PHY", "STA", "ENT", "CHM", "BIO"]);

function show(prog: string, c: Course) {
  console.log(`\n=== ${c.code}: ${c.title}  [${prog}, PDF page ${c.page}]`);
  console.log(`    ${c.units} units, status ${c.status}, LH ${c.lh}, PH ${c.ph}, level ${c.level}`);
  if (c.outcomes_intro) console.log(`    Outcomes intro: ${c.outcomes_intro}`);
  c.outcomes.forEach((o, i) => console.log(`    ${i + 1}. ${o}`));
  console.log(`    Contents: ${c.contents.slice(0, 400)}${c.contents.length > 400 ? "…" : ""}`);
  if (c.lab_work) console.log(`    Lab work: ${c.lab_work.slice(0, 200)}`);
}

const [slug, ...codes] = process.argv.slice(2);
const d: Discipline = JSON.parse(readFileSync(join(DATA_DIR, `${slug}.json`), "utf8"));

if (codes.length) {
  for (const p of d.programmes) for (const c of p.courses) if (codes.includes(c.code)) show(p.name, c);
} else {
  const problems: string[] = [];
  let total = 0;
  for (const p of d.programmes) {
    for (const c of p.courses) {
      total++;
      const missing = (["outcomes", "contents", "status"] as const).filter((k) => !(Array.isArray(c[k]) ? c[k].length : c[k]));
      if (missing.length || c.title.length > 90) {
        problems.push(`  ${p.name} | ${c.code} p${c.page} missing=[${missing.join(", ")}] title=${JSON.stringify(c.title.slice(0, 60))}`);
      }
    }
  }
  console.log(`${problems.length} of ${total} courses look incomplete:`);
  console.log(problems.slice(0, 40).join("\n") + (problems.length > 40 ? "\n  …" : ""));
  for (const p of d.programmes) {
    const own = p.courses.filter((c) => !SHARED.has(c.code.slice(0, 3)));
    if (own.length) show(p.name, own[Math.floor(own.length / 2)]);
  }
}
