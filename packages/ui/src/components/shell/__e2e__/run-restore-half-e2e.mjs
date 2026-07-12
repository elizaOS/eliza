// Regression e2e for the maximize → pull-down-to-half settle (#16151 follow-up):
// after a restore drag released near the HALF height, the sheet must REST at
// the half detent — not spring back to the maximized height with the inset
// shape (restore bookkeeping raced by the maximize-release hysteresis) and not
// collapse (a stale invisible grabber capturing the drag over the restore
// strip). Drives the real overlay in headless Chromium with real pointer
// gestures and samples detent/chat-state/height for 2s after release.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  stubElizaCore,
  stubNodeBuiltins,
  writeFixturePage,
} from "../../../testing/e2e-runner/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-restore-half-repro");
await mkdir(outDir, { recursive: true });

const url = await writeFixturePage({
  entry: join(here, "chat-sheet-fixture.tsx"),
  outDir,
  htmlName: "chat-sheet.html",
  title: "restore half repro",
  plugins: [stubElizaCore(), stubNodeBuiltins()],
  processShim: true,
  background: "#0a0d16",
  headHtml: "<style>.bg-bg{background-color:#0a0d16}</style>",
});

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 420, height: 900 } });
p.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text());
});
await p.goto(url, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(600);

const state = async () => {
  const sheet = p.getByTestId("chat-sheet");
  return {
    detent: await sheet.getAttribute("data-detent"),
    chat: await sheet.getAttribute("data-chat-state"),
    maximized: await sheet.getAttribute("data-maximized"),
    h: await p.evaluate(
      () =>
        document
          .querySelector('[data-testid="chat-thread"]')
          ?.getBoundingClientRect().height ?? 0,
    ),
  };
};

async function dragFrom(testId, dy, { steps = 20, slow = true, trace = false } = {}) {
  const b = await p.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`no box for ${testId}`);
  const cx = b.x + b.width / 2;
  const cy = b.y + Math.min(b.height / 2, 20);
  await p.mouse.move(cx, cy);
  await p.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await p.mouse.move(cx, cy + (dy * i) / steps);
    if (slow) await p.waitForTimeout(24);
    if (trace && i % 4 === 0) {
      const s = await state();
      console.log(`  drag step ${i}/${steps} y=${Math.round(cy + (dy * i) / steps)}:`, JSON.stringify(s));
    }
  }
  await p.mouse.up();
}

// 1. Open the sheet to full, then maximize with a big pull.
console.log("start:", await state());
await dragFrom("chat-sheet-grabber", -300, { steps: 6, slow: false });
await p.waitForTimeout(700);
console.log("after open pull:", await state());
await dragFrom("chat-sheet-grabber", -760, { steps: 24 });
await p.waitForTimeout(900);
const maxed = await state();
console.log("after maximize pull:", maxed);
if (maxed.chat !== "MAXIMIZED") {
  console.log("FAIL: never maximized — cannot run repro");
  process.exit(2);
}

// 2. Restore drag: pull DOWN from the restore zone to roughly HALF height.
// viewport 900 → halfH ≈ 900*0.46 ≈ 414. The maximized thread is ~860 tall;
// drag down by (max - half) ≈ 440px and release.
await dragFrom("chat-maximize-restore-zone", 440, { steps: 22 });

// 3. Sample the settle for 2s.
for (let t = 0; t <= 2000; t += 250) {
  const s = await state();
  console.log(`t+${t}ms:`, JSON.stringify(s));
  await p.waitForTimeout(250);
}

const final = await state();
const halfH = Math.round(900 * 0.46);
const restedNearHalf = Math.abs(final.h - halfH) < 120;
console.log(
  restedNearHalf
    ? "PASS: rested near half"
    : `BUG REPRODUCED: rested at ${final.h} (halfH=${halfH}) state=${JSON.stringify(final)}`,
);
await browser.close();
process.exit(restedNearHalf ? 0 : 1);
