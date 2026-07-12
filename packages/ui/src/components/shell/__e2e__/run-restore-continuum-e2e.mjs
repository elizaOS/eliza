// Regression e2e for the maximize → restore continuum (the on-device travel
// deficit): (1) settled full-bleed carries the composer content-tuck margin
// and drops the drag GPU promotion; (2) a slow restore run to the screen
// bottom never consumes the composer row and lands the pill; (3) a downward
// FLICK mid-restore completes decisively to a real state (half / input) —
// never a stub free-rest ("keeps pulling height instead of changing state").
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import {
  stubElizaCore,
  stubNodeBuiltins,
  writeFixturePage,
} from "../../../testing/e2e-runner/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-restore-continuum");
await mkdir(outDir, { recursive: true });
const url = await writeFixturePage({
  entry: join(here, "chat-sheet-fixture.tsx"),
  outDir,
  htmlName: "chat-sheet.html",
  title: "restore continuum e2e",
  plugins: [stubElizaCore(), stubNodeBuiltins()],
  processShim: true,
  background: "#0a0d16",
});

let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch();

async function freshMaximizedPage() {
  const p = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(600);
  await drag(p, "chat-sheet-grabber", -300, 6, 0);
  await p.waitForTimeout(600);
  await drag(p, "chat-sheet-grabber", -760, 20, 18);
  await p.waitForTimeout(900);
  return p;
}
async function drag(p, testId, dy, steps, stepDelay = 20) {
  const b = await p.getByTestId(testId).boundingBox();
  const cx = b.x + b.width / 2;
  const cy = b.y + Math.min(b.height / 2, 20);
  await p.mouse.move(cx, cy);
  await p.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await p.mouse.move(cx, Math.min(898, cy + (dy * i) / steps));
    if (stepDelay) await p.waitForTimeout(stepDelay);
  }
  await p.mouse.up();
}
const snap = (p) =>
  p.evaluate(() => {
    const sheet = document.querySelector('[data-testid="chat-sheet"]');
    const row = document.querySelector('[data-testid="chat-composer-row"]');
    const thread = document.querySelector('[data-testid="chat-thread"]');
    return {
      detent: sheet.getAttribute("data-detent"),
      chat: sheet.getAttribute("data-chat-state"),
      willChange: sheet.style.willChange || "",
      threadMB: thread ? getComputedStyle(thread).marginBottom : "0px",
      rowH: Math.round(row?.getBoundingClientRect().height ?? -1),
      h: Math.round(thread?.getBoundingClientRect().height ?? 0),
    };
  });

// (1) Settled full-bleed state.
{
  const p = await freshMaximizedPage();
  const s = await snap(p);
  assert(s.chat === "MAXIMIZED", `maximized (${s.chat})`);
  assert(
    Number.parseFloat(s.threadMB) <= -40,
    `content tuck applies at settled full-bleed (margin ${s.threadMB})`,
  );
  assert(
    s.willChange !== "transform",
    `drag GPU promotion dropped at rest (will-change "${s.willChange}")`,
  );

  // (2) Slow restore to the bottom: composer never consumed; pill lands.
  const b = await p.getByTestId("chat-maximize-restore-zone").boundingBox();
  const cx = b.x + b.width / 2;
  const cy = b.y + 10;
  await p.mouse.move(cx, cy);
  await p.mouse.down();
  let minRow = Number.POSITIVE_INFINITY;
  for (let i = 1; i <= 30; i += 1) {
    await p.mouse.move(cx, Math.min(898, cy + (900 * i) / 30));
    await p.waitForTimeout(20);
    if (i > 20) minRow = Math.min(minRow, (await snap(p)).rowH);
  }
  await p.mouse.up();
  await p.waitForTimeout(900);
  const end = await snap(p);
  assert(
    minRow >= 40,
    `composer row survives the whole restore tail (min ${minRow}px ≥ 40)`,
  );
  assert(end.detent === "pill", `bottom run lands the PILL (${end.detent})`);
  await p.close();
}

// (3) Downward flick mid-restore completes to a real state.
{
  const p = await freshMaximizedPage();
  // Fast flick: cover ~60% of the screen quickly, releasing with velocity —
  // the on-device case where the finger runs out of travel.
  await drag(p, "chat-maximize-restore-zone", 560, 5, 12);
  await p.waitForTimeout(900);
  const s = await snap(p);
  assert(
    s.chat !== "MAXIMIZED" && s.chat !== "OPEN_UNDER_HALF",
    `mid flick completes to a real state, not a stub free-rest (${s.chat} / ${s.detent})`,
  );
  await p.close();
}

await browser.close();
process.exit(failures === 0 ? 0 : 1);
