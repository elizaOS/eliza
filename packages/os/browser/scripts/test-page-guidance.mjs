/** Actual isolated-world guidance DOM, not native host or Android acceptance. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { pageCommand } from "../src/commands.mjs";
import { pageGuidance } from "../src/page-guidance.mjs";

const require = createRequire(
  import.meta.resolve("@elizaos/plugin-browser/package.json"),
);
const { default: puppeteer } = require("puppeteer-core");
if (!process.env.ELIZA_BROWSER_EXECUTABLE)
  throw new Error("Set ELIZA_BROWSER_EXECUTABLE");
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<!doctype html><style>body{height:2400px;font:22px system-ui}button{margin:100px 20px;padding:20px}</style><button id="target">Continue on this website</button><input type="password" value="private-secret"><p>Provider content</p>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
const cases = [];
try {
  browser = await puppeteer.launch({
    executablePath: process.env.ELIZA_BROWSER_EXECUTABLE,
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  const cdp = await page.createCDPSession();
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "eliza-guidance-test",
  });
  const evaluate = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(
      r.exceptionDetails,
      undefined,
      JSON.stringify(r.exceptionDetails),
    );
    return r.result.value;
  };
  const call = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  let sequence = 0;
  const offer = async (id = "step-1", extra = {}) => {
    const snapshotId = `guide-${++sequence}`;
    const snapshot = await call(
      pageCommand,
      { subaction: "snapshot" },
      snapshotId,
    );
    assert.ok(!JSON.stringify(snapshot).includes("private-secret"));
    assert.ok(!snapshot.text.includes("Use this control when you are ready."));
    assert.ok(!snapshot.elements.some((e) => e.label === "Dismiss guidance"));
    const target = snapshot.elements.find(
      (e) => e.label === "Continue on this website",
    );
    return call(pageGuidance, {
      kind: "show",
      id,
      origin,
      snapshotId,
      nodeId: target.id,
      text: "Use this control when you are ready.",
      expiresAt: Date.now() + 60000,
      ...extra,
    });
  };
  const state = () =>
    evaluate(
      `(()=>{const s=globalThis.__elizaPageGuidanceV1;const target=document.querySelector('#target').getBoundingClientRect();const label=s.shadow.querySelector('.label').getBoundingClientRect();return {visible:s.visible,dismissed:s.dismissed,target:{x:target.x,y:target.y,width:target.width,height:target.height},label:{x:label.x,y:label.y,width:label.width,height:label.height}}})()`,
    );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  const original = await page.$eval("#target", (node) => ({
    style: node.getAttribute("style"),
    text: node.textContent,
  }));
  assert.equal((await offer()).accepted, true);
  await settle();
  assert.equal(
    await evaluate(
      "globalThis.__elizaBrowserControlV1.domRevision === globalThis.__elizaBrowserObservationV1.domRevision",
    ),
    true,
  );
  await call(pageGuidance, { kind: "hide" });
  await settle();
  assert.equal(
    await evaluate(
      "globalThis.__elizaBrowserControlV1.domRevision === globalThis.__elizaBrowserObservationV1.domRevision",
    ),
    true,
  );
  await page.evaluate(() =>
    document.documentElement.append(document.createElement("div")),
  );
  await settle();
  assert.equal(
    await evaluate(
      "globalThis.__elizaBrowserControlV1.domRevision < globalThis.__elizaBrowserObservationV1.domRevision",
    ),
    true,
  );
  await offer();
  await settle();
  cases.push(
    "only trusted guide mount/removal is excluded from DOM revisions; provider insertion invalidates",
  );
  const s = await state();
  assert.equal(s.visible, true);
  assert.equal(
    await evaluate(
      'getComputedStyle(globalThis.__elizaPageGuidanceV1.shadow.querySelector(".label")).fontSize',
    ),
    "20px",
  );
  assert.ok(
    s.label.y >= s.target.y + s.target.height ||
      s.label.y + s.label.height <= s.target.y ||
      s.label.x >= s.target.x + s.target.width ||
      s.label.x + s.label.width <= s.target.x,
  );
  assert.deepEqual(
    await page.$eval("#target", (node) => ({
      style: node.getAttribute("style"),
      text: node.textContent,
    })),
    original,
  );
  assert.equal(
    await page.evaluate(() => globalThis.__elizaPageGuidanceV1),
    undefined,
  );
  cases.push("isolated annotation does not restyle provider or cover target");
  await evaluate(
    "globalThis.__elizaPageGuidanceV1.shadow.querySelector('button').click()",
  );
  assert.equal((await state()).visible, false);
  assert.equal((await offer()).dismissed, true);
  await settle();
  assert.equal((await state()).visible, false);
  await offer("step-1", { restore: true });
  await settle();
  assert.equal((await state()).visible, true);
  cases.push(
    "same-step dismissal persists across fresh offers; explicit restore works",
  );
  await page.evaluate(() => scrollTo(0, 700));
  await settle();
  assert.equal((await state()).visible, false);
  await page.evaluate(() => scrollTo(0, 0));
  await settle();
  assert.equal((await state()).visible, true);
  await page.setViewport({ width: 640, height: 960 });
  await settle();
  assert.equal((await state()).visible, true);
  cases.push("scroll and viewport resize re-anchor only after stable geometry");
  await page.$eval("#target", (node) => (node.style.marginTop = "180px"));
  await settle();
  assert.equal((await state()).visible, false);
  await offer();
  await settle();
  assert.equal((await state()).visible, true);
  cases.push("DOM movement requires a fresh observation");
  await page.$eval("input", (node) =>
    node.dispatchEvent(new InputEvent("beforeinput", { bubbles: true })),
  );
  await settle();
  assert.equal((await state()).visible, false);
  await offer("manual-next");
  await settle();
  assert.equal((await state()).visible, true);
  await evaluate(
    "globalThis.__elizaPageGuidanceV1.shadow.querySelector('button').click()",
  );
  await offer("genuinely-new-step");
  await settle();
  assert.equal((await state()).visible, true);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.25 });
  await settle();
  const zoomed = await state();
  if (zoomed.visible)
    assert.ok(
      zoomed.label.y >= zoomed.target.y + zoomed.target.height ||
        zoomed.label.y + zoomed.label.height <= zoomed.target.y ||
        zoomed.label.x >= zoomed.target.x + zoomed.target.width ||
        zoomed.label.x + zoomed.label.width <= zoomed.target.x,
    );
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await settle();
  cases.push(
    "manual input hides guidance; new step restores; zoom never overlaps target",
  );
  const output = testOutputPath("page-guidance");
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/narrow.png` });
  await page.setViewport({ width: 1280, height: 800 });
  await settle();
  await page.screenshot({ path: `${output}/desktop.png` });
  await offer("expiry", { expiresAt: Date.now() + 300 });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal((await state()).visible, false);
  assert.equal(
    (await offer("wrong-origin", { origin: "https://other.example" })).reason,
    "invalid-context",
  );
  await offer("hide");
  await settle();
  await call(pageGuidance, { kind: "hide" });
  assert.equal((await state()).visible, false);
  cases.push("expiry, origin mismatch and host hide remove guidance");
  await writeFile(
    `${output}/verification.json`,
    JSON.stringify(
      {
        cases,
        browser: await browser.version(),
        scope:
          "actual Chromium DOM and isolated realm; host integration and Android unverified",
      },
      null,
      2,
    ),
  );
  console.log(`PASS page guidance: ${cases.join("; ")}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
