#!/usr/bin/env node
/**
 * Compose every route screenshot captured by the aesthetic-audit e2e spec
 * into a single contact sheet (one HTML file with an image grid + one
 * per-viewport PNG mosaic-style index) so cohesion can be evaluated at a
 * glance.
 *
 * Inputs:   test-results/aesthetic/<viewport>/<route>.png
 * Outputs:  test-results/aesthetic/contact-sheet.html
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ARTIFACT_DIR = path.join(ROOT, "test-results/aesthetic");
const OUTPUT = path.join(ARTIFACT_DIR, "contact-sheet.html");

if (!existsSync(ARTIFACT_DIR)) {
  console.error(
    `[contact-sheet] No aesthetic artifacts at ${ARTIFACT_DIR}.\n` +
      "Run: bun --cwd packages/homepage test:e2e -- aesthetic-audit",
  );
  process.exit(1);
}

const viewports = readdirSync(ARTIFACT_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

if (viewports.length === 0) {
  console.error("[contact-sheet] No viewport subdirectories found.");
  process.exit(1);
}

const sections = viewports
  .map((vp) => {
    const files = readdirSync(path.join(ARTIFACT_DIR, vp))
      .filter((f) => f.endsWith(".png"))
      .sort();
    const cards = files
      .map(
        (f) => `
      <figure class="card">
        <figcaption>${f.replace(/\.png$/, "")}</figcaption>
        <img src="./${vp}/${f}" alt="${vp} ${f}" loading="lazy" />
      </figure>`,
      )
      .join("\n");
    return `
    <section>
      <h2>${vp}</h2>
      <div class="grid grid-${vp}">${cards}\n      </div>
    </section>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Eliza Homepage — Contact Sheet</title>
<style>
  :root { --bg: #f7f7f4; --fg: #08090c; --accent: #ff6600; --xs: 3px; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem; background: var(--bg); color: var(--fg); font-family: Poppins, system-ui, sans-serif; }
  h1 { font-size: 1.75rem; margin: 0 0 1rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; }
  .grid { display: grid; gap: 1rem; }
  .grid-desktop { grid-template-columns: repeat(2, 1fr); }
  .grid-mobile { grid-template-columns: repeat(4, 1fr); }
  figure { margin: 0; background: white; border: 1px solid #00000018; border-radius: var(--xs); overflow: hidden; }
  figcaption { padding: 0.5rem 0.75rem; font-size: 0.85rem; font-weight: 500; background: var(--accent); color: var(--fg); }
  img { display: block; width: 100%; height: auto; }
</style>
</head>
<body>
  <h1>Eliza Homepage — Contact Sheet</h1>
  <p>Generated ${new Date().toISOString()}. Captures every route at every viewport for cohesion review.</p>
  ${sections}
</body>
</html>`;

writeFileSync(OUTPUT, html);
console.log(
  `[contact-sheet] Wrote ${OUTPUT} (${viewports.length} viewport(s)).`,
);
