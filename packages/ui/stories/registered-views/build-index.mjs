/**
 * Build the contact sheet + per-view review stubs for the registered-view
 * screenshots. Reads the captured artifacts under `stories/__screens__/`
 * (gui/<id>.png, xr/<id>.png, tui/<id>.txt) and writes:
 *
 *   - `__screens__/contact-sheet.html` — a grid indexing GUI + XR + TUI per view.
 *   - `__screens__/review/<id>.md`     — a per-view verdict stub (good ·
 *                                        needs-work · needs-eyeball · broken),
 *                                        mirroring the cloud-frontend audit
 *                                        manual-review convention. Existing
 *                                        verdicts are preserved (re-run safe).
 *
 *   bun stories/registered-views/build-index.mjs
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const screensDir = resolve(here, "../__screens__");
const guiDir = resolve(screensDir, "gui");
const xrDir = resolve(screensDir, "xr");
const tuiDir = resolve(screensDir, "tui");
const reviewDir = resolve(screensDir, "review");

const pngIds = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".png"))
        .map((f) => f.replace(/\.png$/, ""))
    : [];
const txtIds = existsSync(tuiDir)
  ? readdirSync(tuiDir)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => f.replace(/\.txt$/, ""))
  : [];

const ids = [
  ...new Set([...pngIds(guiDir), ...pngIds(xrDir), ...txtIds]),
].sort();

// --- review stubs (preserve existing verdicts) ------------------------------
import { mkdirSync } from "node:fs";

mkdirSync(reviewDir, { recursive: true });

for (const id of ids) {
  const file = resolve(reviewDir, `${id}.md`);
  if (existsSync(file)) continue; // keep human-filled verdicts
  const hasGui = existsSync(resolve(guiDir, `${id}.png`));
  const hasXr = existsSync(resolve(xrDir, `${id}.png`));
  const hasTui = existsSync(resolve(tuiDir, `${id}.txt`));
  const surfaces = [
    hasGui && "`../gui/" + id + ".png`",
    hasXr && "`../xr/" + id + ".png`",
    hasTui && "`../tui/" + id + ".txt`",
  ]
    .filter(Boolean)
    .join(", ");
  writeFileSync(
    file,
    `# Manual review — ${id}\n\nRegistered plugin view rendered on all three surfaces.\nScreenshots: ${surfaces}\n\n## Verdict\n\n\`needs-eyeball\`\n\n<!-- Replace with good · needs-work · needs-eyeball · broken and a one-line note. -->\n`,
  );
}

// --- contact sheet ----------------------------------------------------------
const cell = (id) => {
  const tuiTxt = existsSync(resolve(tuiDir, `${id}.txt`))
    ? readFileSync(resolve(tuiDir, `${id}.txt`), "utf8")
    : "(no tui render)";
  // Show just the 56-col block of the TUI render in the sheet.
  const block = tuiTxt
    .split("\n")
    .filter((l, i, a) => {
      const start = a.findIndex((x) => x.includes("@ 56 cols"));
      const next = a.findIndex((x, j) => j > start && x.includes("@ 40 cols"));
      return start >= 0 && i > start && (next < 0 || i < next);
    })
    .join("\n")
    .trim();
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `
  <section class="view" id="${id}">
    <h2>${id}</h2>
    <div class="row">
      <figure><figcaption>GUI</figcaption><img src="gui/${id}.png" loading="lazy" alt="${id} gui"></figure>
      <figure><figcaption>XR</figcaption><img src="xr/${id}.png" loading="lazy" alt="${id} xr"></figure>
      <figure class="tui"><figcaption>TUI (56 cols)</figcaption><pre>${esc(block)}</pre></figure>
    </div>
    <p class="review">verdict: <a href="review/${id}.md">review/${id}.md</a></p>
  </section>`;
};

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Registered views — tri-modal contact sheet</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0e14; color:#e7e9ee; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding:24px 24px 8px; }
  h1 { margin:0 0 4px; font-size:22px; }
  .meta { color:#9aa0ab; margin:0 0 16px; }
  .view { padding:18px 24px; border-top:1px solid rgba(160,168,180,.2); }
  .view h2 { margin:0 0 10px; font-size:16px; color:#e8590c; }
  .row { display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap; }
  figure { margin:0; }
  figcaption { font-size:11px; text-transform:uppercase; letter-spacing:.8px; color:#9aa0ab; margin-bottom:6px; }
  img { max-width:380px; border:1px solid rgba(160,168,180,.28); border-radius:8px; background:#13161c; }
  figure.tui pre { margin:0; background:#0b0d11; color:#cbd0d8; border:1px solid rgba(160,168,180,.28); border-radius:8px; padding:10px 12px; font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; line-height:1.35; }
  .review { margin:10px 0 0; font-size:12px; }
  .review a { color:#e8590c; }
  nav { padding:0 24px 16px; color:#9aa0ab; font-size:12px; display:flex; flex-wrap:wrap; gap:8px; }
  nav a { color:#9aa0ab; }
</style></head>
<body>
<header>
  <h1>Registered plugin views — one view, three surfaces</h1>
  <p class="meta">${ids.length} views. Each is authored once and rendered to GUI (DOM), XR (scaled DOM), and TUI (real terminal lines). Per-view verdict stubs under <code>review/</code>.</p>
</header>
<nav>${ids.map((id) => `<a href="#${id}">${id}</a>`).join("")}</nav>
${ids.map(cell).join("\n")}
</body></html>`;

writeFileSync(resolve(screensDir, "contact-sheet.html"), html);

console.log(
  `contact sheet + ${ids.length} review stubs written (gui=${pngIds(guiDir).length} xr=${pngIds(xrDir).length} tui=${txtIds.length})`,
);
