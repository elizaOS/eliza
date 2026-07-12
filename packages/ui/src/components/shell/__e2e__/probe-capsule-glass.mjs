// Probe: at full-bleed, does chat-composer-row actually carry the backdrop
// blur + white fill (computed styles), on chromium AND webkit?
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { stubElizaCore, stubNodeBuiltins, writeFixturePage } from "../../../testing/e2e-runner/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-capsule-probe");
await mkdir(outDir, { recursive: true });
const url = await writeFixturePage({
  entry: join(here, "chat-sheet-fixture.tsx"),
  outDir, htmlName: "chat-sheet.html", title: "capsule probe",
  plugins: [stubElizaCore(), stubNodeBuiltins()], processShim: true,
  background: "#0a0d16",
});
for (const [name, type] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await type.launch();
  const p = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(600);
  // open to full then maximize with a long pull
  const drag = async (dy, steps = 20) => {
    const b = await p.getByTestId("chat-sheet-grabber").boundingBox();
    const cx = b.x + b.width / 2, cy = b.y + Math.min(b.height / 2, 20);
    await p.mouse.move(cx, cy); await p.mouse.down();
    for (let i = 1; i <= steps; i++) { await p.mouse.move(cx, cy + (dy * i) / steps); await p.waitForTimeout(20); }
    await p.mouse.up();
  };
  await drag(-300, 6); await p.waitForTimeout(600);
  await drag(-760, 24); await p.waitForTimeout(900);
  const state = await p.getByTestId("chat-sheet").getAttribute("data-chat-state");
  const styles = await p.getByTestId("chat-composer-row").evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      backdropFilter: cs.backdropFilter ?? "(none-prop)",
      webkitBackdropFilter: cs.webkitBackdropFilter ?? cs["-webkit-backdrop-filter"] ?? "(none-prop)",
      backgroundColor: cs.backgroundColor,
      inlineBackdrop: el.style.backdropFilter,
      inlineWebkit: el.style.webkitBackdropFilter,
    };
  });
  console.log(name, "state=", state, JSON.stringify(styles, null, 1));
  await p.screenshot({ path: join(outDir, `${name}-max.png`), clip: { x: 0, y: 640, width: 420, height: 260 } });
  await browser.close();
}
