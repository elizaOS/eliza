/** Real Chromium DOM and isolated realm; Android reply-proxy coverage is separate. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(
  import.meta.resolve("@elizaos/plugin-browser/package.json"),
);
const { default: puppeteer } = require("puppeteer-core");
if (!process.env.ELIZA_BROWSER_EXECUTABLE)
  throw new Error("Set ELIZA_BROWSER_EXECUTABLE");
const source = await readFile(
  new URL("../resources/control-channel.js", import.meta.url),
  "utf8",
);
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    `<!doctype html><input id="query" aria-label="Search query"><input type="password" value="private-value"><button type="button" id="increment" onclick="document.querySelector('output').textContent++">Increment</button><output>0</output>`,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.ELIZA_BROWSER_EXECUTABLE,
    headless: true,
  });
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  const cdp = await page.createCDPSession();
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "eliza-native-control-test",
  });
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression,
      returnByValue: true,
    });
    assert.equal(
      result.exceptionDetails,
      undefined,
      JSON.stringify(result.exceptionDetails),
    );
    return result.result.value;
  };
  const ready = await evaluate(
    `globalThis.messages=[]; globalThis.elizaSurfaceControl={postMessage:value=>messages.push(JSON.parse(value))}; ${source}; messages.pop()`,
  );
  assert.equal(ready.ready, true);
  let sequence = 0;
  const dispatch = (command, extra = {}) =>
    evaluate(
      `elizaSurfaceControl.onmessage({data:${JSON.stringify(JSON.stringify({ documentId: ready.documentId, sequence: ++sequence, command, ...extra }))}}); messages.pop()`,
    );
  const snapshot = async () =>
    (await dispatch({ subaction: "snapshot" })).result;
  const policy = {
    origin,
    expiresAt: Date.now() + 60000,
    targets: [
      { selector: "#increment", action: "click" },
      { selector: "#query", action: "fill" },
    ],
  };
  let state = await snapshot();
  assert.equal(state.complete, true);
  assert.ok(!JSON.stringify(state).includes("private-value"));
  assert.equal(
    await page.evaluate(() => typeof globalThis.elizaSurfaceControl),
    "undefined",
  );
  assert.equal(
    await page.evaluate(() => typeof globalThis.__elizaBrowserControlV1),
    "undefined",
  );
  const action = (state, subaction, target, extra = {}) => ({
    subaction,
    nodeId: state.elements.find((item) => item.targetSelector === target).id,
    snapshotId: state.snapshotId,
    taskPolicy: policy,
    ...extra,
  });
  const click = action(state, "click", "#increment");
  assert.equal((await dispatch(click)).result.dispatched, true);
  assert.equal(await page.$eval("output", (node) => node.textContent), "1");
  const consumed = sequence;
  assert.equal(
    (await dispatch(click, { sequence: consumed })).result.error.kind,
    "STALE_REF",
  );
  assert.equal(await page.$eval("output", (node) => node.textContent), "1");
  state = await snapshot();
  const fill = action(state, "fill", "#query", { text: "Wikipedia" });
  assert.equal(
    (await dispatch(fill, { documentId: "retired-document" })).result.error
      .kind,
    "STALE_REF",
  );
  assert.equal(await page.$eval("#query", (node) => node.value), "");
  assert.equal(
    (await dispatch({ ...fill, taskPolicy: null })).result.error.kind,
    "POLICY_BLOCKED",
  );
  assert.equal((await dispatch(fill)).result.dispatched, true);
  assert.equal(await page.$eval("#query", (node) => node.value), "Wikipedia");
  state = await snapshot();
  await page.type("#query", " by hand");
  assert.equal(
    (await dispatch(action(state, "fill", "#query", { text: "overwrite" })))
      .result.error.kind,
    "STALE_REF",
  );
  assert.equal(
    await page.$eval("#query", (node) => node.value),
    "Wikipedia by hand",
  );
  assert.equal(
    (await dispatch({ subaction: "evaluate", script: "alert(1)" })).result.error
      .kind,
    "UNSUPPORTED",
  );
  // A website can define the same names in its world without replacing the
  // channel, its sequence or the snapshot node references.
  await page.evaluate(() => {
    globalThis.elizaSurfaceControl = {
      onmessage: () => {
        throw new Error("page spoof");
      },
    };
    globalThis.__elizaBrowserControlV1 = { snapshotId: "spoof" };
  });
  state = await snapshot();
  assert.equal(
    (await dispatch(action(state, "click", "#increment"))).result.dispatched,
    true,
  );
  assert.equal(await page.$eval("output", (node) => node.textContent), "2");
  console.log(
    "PASS: isolated command channel, real click/fill, document and replay fences, manual input, policy requirement, fixed operations, credential exclusion",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
