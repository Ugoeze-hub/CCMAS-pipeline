# CCMAS extraction — handoff notes

Started 2026-11-06. Standalone repo: github.com/Ugoeze-hub/CCMAS-pipeline (public).
Read this first, then carry on from "Next steps".

## Goal

Pull the NUC **CCMAS** (Core Curriculum and Minimum Academic Standards) course outlines for every
department across the faculties, and present them as an **interactive webpage** (pick discipline →
department → courses by level; search by code/title; click a course for its outline; link back to the
source PDF page). A PDF export per department can be made later from the same data if needed.

**Not** going into the Wekoya app or Joshua's academic catalog right now.

## Decisions so far

- Standalone repo, `main` branch. Layout: code in `scripts/`, output JSON in `data/`, PDFs cached in
  `pdfs/` (gitignored).
- The user does all commits/pushes — leave changes uncommitted and give them the commands.
- Hosting: **GitHub Pages** from this public repo (`index.html` at the repo root reads `data/*.json`).
- Explain each step and *why* before running it — the user wants to follow the process.

## Source: NUC CCMAS page

https://www.nuc.edu.ng/ccmas/ — one page, 17 PDFs (one per discipline), no per-department breakdown on
the page itself. Disciplines: Administration, Allied Health Sciences, Architecture, Arts, Basic Medical
Science, Computing, Communication and Media Studies, Education, Environmental Sciences, Law, Medicine and
Dentistry, Pharmacy and Pharmaceutical Sciences, Sciences, Social Sciences, Veterinary Medicine,
Engineering/Technology, Agriculture.

PDFs are under `https://www.nuc.edu.ng/wp-content/uploads/2026/03/`, e.g.
`Computing-CCMAS-2023-FINAL.pdf` (2.2 MB), `Administration-and-Management.pdf`, `Law-ALL.pdf`,
`Education-CCMAS-2023-New.pdf` (10 MB), `Agriculture-2023.pdf`. Scrape the page for the full list of links.

CCMAS only covers the shared ~70% core, not each university's own ~30%.
Other sources are listed in the user's Google Doc "CCMAS" (Federal BRIDGE course browser, GOUNI, ABU PDF, …) — later.

## What we found in the Computing PDF (`pdfs/Computing-CCMAS-2023-FINAL.pdf`)

- **Real text, not scans** → extraction is free; no OCR needed. `pdftotext -layout` is installed
  (no pypdf / PyMuPDF). 229 pages, ~78k words, only 2 near-empty pages. Other PDFs (some 700+ pages) still
  need the same check.
- Table of contents on page 11 lists programmes (= departments) with start pages:
  B.Sc. Computer Science 27, Cybersecurity 56, Data Science 93, Information and Communication Technology 120,
  Information Systems 148, Information Technology 174, Software Engineering 202.
  TOC line regex that worked: `^\s*(B\.\s?[A-Za-z.]+\s.+?)\s*\.{3,}\s*(\d+)\s*$`
- Each programme: Overview, Philosophy, Objectives, …, Global Course Structure, **Course Contents and
  Learning Outcomes**, Minimum Academic Standards.
- Course heading format: `COS 101: Introduction to Computing Sciences (3 Units C: LH 30; PH 45)`
  (C = compulsory, LH = lecture hours, PH = practical hours). Regex that found 260 headings:
  `^\s*([A-Z]{3})\s?(\d{3})\s*[:\-–]?\s*(.+?\(\s*\d+\s*Units?.*)$` (multiline).
  Some headings wrap onto the next line (e.g. "MTH 101 … (2 Units" then rest below).
- Each course: heading → "Learning Outcomes" (numbered list) → "Course Contents" paragraph → sometimes
  "Lab Work:". Shared courses (GST, MTH, PHY, STA, ENT…) repeat under every programme.
- Page footers like `Computing 35 New` get mixed into the text — strip them.
- On Windows, set `PYTHONIOENCODING=utf-8` when printing extracted text (cp1252 crash otherwise).
- User confirmed COS 101 (page 35) matches the PDF.

## Pipeline (built 2026-11-06)

- Code is TypeScript in `scripts/` (Node 24 runs `.ts` directly; `npm run typecheck` covers it).
  No runtime npm packages; needs `pdftotext` on PATH.
- `npm run pipeline -- [--only <name>] [--cache] [--dump-text]` does everything: scrapes the NUC page
  (17 PDF links), fetches each PDF (temp file, deleted after; uses/keeps a copy in `pdfs/` with `--cache`),
  extracts text, parses TOC -> programmes -> courses, writes `data/<slug>.json`.
- `npm run spotcheck -- <slug> ["COS 101" ...]` flags incomplete courses and prints samples.
- `npm run serve` previews the page at http://localhost:8000 (no packages; file:// can't fetch the JSON).
- `data/index.json` (faculties + programmes, written at the end of each pipeline run) lets the page list
  everything without loading all 18 MB; each faculty's JSON loads when picked.
- Computing: 7 programmes, 260 courses. Fixed: wide-spaced footers leaking into text, "C1:" status typo,
  SIWES courses (description only, no section headers -> stored as contents). Only SIWES lack outcomes (genuine).

## Next steps

1. ~~Repo setup, ignore PDFs~~ done.
2. ~~Computing extraction~~ done -> `data/computing.json`.
3. User spot-checks samples (CSC 309 p44, CYB 305 p76, DTS 304 p111, ICT 309 p138, SEN 304 p219, COS 201 p38).
4. ~~All 17 faculties~~ done: 238 programmes, ~10,700 courses. Fixes: TOC programmes = entry before
   "Overview" (handles LL.B, MBBS, Pharm.D, DVM, dash leaders); programmes anchored on their own Overview
   page (Arts TOC page numbers drift ~14 pages); courses bounded by "Course Contents and Learning Outcomes"
   (else "Global Course Structure") .. "Minimum Academic Standards"; headings wrapped over up to 4 lines,
   "(2 Units; C) (LH 30)", "UnitsC"/"Unite" typos, text after the heading; prerequisites captured.
5. ~~`index.html`~~ done (plain page: faculty -> department -> courses by level, search, PDF page links).
6. Turn on GitHub Pages (Settings -> Pages -> main / root).

## Known gaps

- Chinese Studies (Arts): headings use full-width brackets `（2 Units` -> only 9 courses parsed. One-line fix
  (normalise （ ） in cleanLines).
- Short programmes to check against the PDF: Finance/Banking (13), Education Hausa (17), Human Kinetics (12)
  — may list some courses only in the structure table, without descriptions.
- ~300 courses (3%) lack outcomes/contents/status; many are projects, SIWES, seminars.
