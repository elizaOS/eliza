/**
 * #10732 — terminal-replay screencast (MP4) from the REAL live-classifier run +
 * live e2e gate results. SVG frames (rsvg-convert, fast) → ffmpeg.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const OUT_DIR = ".github/issue-evidence/10732-miniapp-monetization";
const FRAMES = "/tmp/10732-frames";
const W = 1240;
const H = 700;

const C = {
  cmd: "#ff7a1a", dim: "#9aa0a6", line: "#e8eaed", allow: "#4ade80",
  ban: "#f87171", block: "#fbbf24", rat: "#7d8590", ok: "#4ade80",
};
const L = (text, kind = "dim") => ({ text, kind });
const lines = [
  L("$ APP_REVIEW_MODEL=gpt-oss-120b bun scripts/10732-live-classifier-trajectory.mjs", "cmd"),
  L("[trajectory] model=gpt-oss-120b   rubric 2026-07-01.1   (live · Cerebras)", "dim"),
  L("  ALLOW   TaskFlow — to-do & calendar assistant             preFilter=false   ok", "allow"),
  L("          \"standard productivity tool; no prohibited category\"", "rat"),
  L("  ALLOW   DrugFacts — harm-reduction education              preFilter=false   ok", "allow"),
  L("          \"educational only, sells nothing -> allowed (nuance)\"", "rat"),
  L("  BAN     QuickCash Doubler — \"guaranteed 2x in 30 days\"     preFilter=false   ok", "ban"),
  L("          \"deceptive crypto / Ponzi scheme — caught by the LLM\"", "rat"),
  L("  BAN     MediMart — Rx meds, no prescription               preFilter=false   ok", "ban"),
  L("          \"unlicensed pharma — illegal + processor-prohibited\"", "rat"),
  L("[trajectory] 4/4 correct  ->  classifier-trajectory-cerebras.json", "ok"),
  L(" ", "dim"),
  L("$ E2E_ONLY=group-n-review bun run test:e2e      (live HTTP gate + Postgres)", "cmd"),
  L("[check] migration 0156 applied successfully!", "ok"),
  L("  POST /apps/:id/review     no auth             ->  401   ok", "line"),
  L("  GET  /review              new app             ->  review_status: draft   ok", "line"),
  L("  PUT  /monetization        draft app enable    ->  403   ok   blocked: not approved", "block"),
  L("  POST /charges             draft app           ->  403   ok   blocked: not approved", "block"),
  L("  POST /review   \"stolen credit cards\"  ->  pre-filter BAN -> rejected   ok", "ban"),
  L("  approve -> PUT /monetization 200 ok   POST /charges 200 ok   gate opens", "ok"),
  L("  POST /review   clean listing  ->  live classifier 381ms -> APPROVED   ok", "ok"),
  L("   7 pass   0 fail        Ran 7 tests across 1 file", "ok"),
];

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function svg(upto, cursor) {
  const x = 30;
  const startY = 74;
  const lh = 26;
  let body = "";
  for (let i = 0; i < upto; i++) {
    const l = lines[i];
    const y = startY + i * lh;
    body += `<text x="${x}" y="${y}" fill="${C[l.kind]}">${esc(l.text)}</text>`;
    if (i === upto - 1 && cursor) {
      body += `<rect x="${x + esc(l.text).length * 8.4 + 6}" y="${y - 14}" width="9" height="17" fill="#ff7a1a"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0b0d10"/>
  <circle cx="30" cy="28" r="6" fill="#ff5f56"/><circle cx="50" cy="28" r="6" fill="#ffbd2e"/><circle cx="70" cy="28" r="6" fill="#27c93f"/>
  <text x="90" y="33" fill="#4b5563" font-family="monospace" font-size="13">#10732 · miniapp compliance-review gate — live evidence replay</text>
  <g font-family="'SF Mono',Menlo,monospace" font-size="14.5" xml:space="preserve">${body}</g>
</svg>`;
}

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

let f = 0;
function shoot(content) {
  const s = `${FRAMES}/f.svg`;
  writeFileSync(s, content);
  const png = `${FRAMES}/frame_${String(f).padStart(4, "0")}.png`;
  execFileSync("rsvg-convert", ["-w", String(W), "-h", String(H), "-o", png, s], { stdio: "ignore" });
  f++;
}
for (let i = 1; i <= lines.length; i++) {
  shoot(svg(i, true));
  shoot(svg(i, false));
}
for (let h = 0; h < 24; h++) shoot(svg(lines.length, false));
console.log(`rendered ${f} frames`);
execFileSync("ffmpeg", [
  "-y", "-framerate", "7", "-i", `${FRAMES}/frame_%04d.png`,
  "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-movflags", "+faststart",
  `${OUT_DIR}/review-gate-screencast.mp4`,
], { stdio: "ignore" });
console.log(`wrote ${OUT_DIR}/review-gate-screencast.mp4`);
