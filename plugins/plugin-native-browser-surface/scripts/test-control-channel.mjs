/** Real Chromium DOM and isolated realm; Android reply-proxy coverage is separate. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createLocalAgentGateway } from "../../../packages/agent/native-host/gateway.mjs";
import { createSurfaceCommandChannel } from "../../../packages/agent/native-host/surface-channel.mjs";
import { connectSurfaceCommandClient } from "../../../packages/agent/native-host/surface-client.mjs";

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
let browser, client;
const channel = createSurfaceCommandChannel({
  credentialGate: async () => "synthetic-owner",
});
const gateway = createLocalAgentGateway({
  token: "fixture-agent",
  inboundToken: "fixture-host",
  surfaceChannel: channel,
  hostPolicy: {
    origins: [],
    resetPaths: [],
    conversationTitle: "Test",
    abortReason: "test",
    validateTitle() {},
    prepareMessage() {},
    isPaidAction: () => false,
    formatTaskContext: () => "",
  },
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const request = async (path, input, token = "fixture-host") => {
  const response = await fetch(`${gatewayUrl}/browser/surface/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: await response.json() };
};
try {
  assert.equal(
    (await request("connect", { clientId: "renderer", epoch: 1 }, "wrong"))
      .status,
    401,
  );
  let connection;
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
  const nativeDispatch = (command, extra = {}) =>
    evaluate(
      `elizaSurfaceControl.onmessage({data:${JSON.stringify(JSON.stringify({ documentId: ready.documentId, sequence: ++sequence, command, ...extra }))}}); messages.pop()`,
    );
  client = await connectSurfaceCommandClient({
    clientId: "renderer",
    epoch: 1,
    request: async (path, input, signal) => {
      const response = await fetch(`${gatewayUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer fixture-host",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal,
      });
      const body = await response.json();
      if (!response.ok)
        throw Object.assign(new Error(body.error), { code: body.code });
      return body;
    },
    handleCommand: async (input) => {
      const reply = await nativeDispatch(input.command, input.extra);
      // Match the Android reply proxy, which rejects native error results.
      if (reply.result.error)
        throw Object.assign(new Error(reply.result.error.message), {
          code: reply.result.error.kind,
        });
      return reply;
    },
  });
  connection = { connectionId: client.connectionId };
  assert.equal(
    (await request("connect", { clientId: "renderer", epoch: 1 })).status,
    409,
  );
  const dispatch = (command, extra = {}) =>
    channel.request(
      { command, extra },
      { effect: command.subaction !== "snapshot" },
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
  await assert.rejects(dispatch(click, { sequence: consumed }), {
    code: "STALE_REF",
  });
  assert.equal(await page.$eval("output", (node) => node.textContent), "1");
  state = await snapshot();
  const fill = action(state, "fill", "#query", { text: "Wikipedia" });
  await assert.rejects(dispatch(fill, { documentId: "retired-document" }), {
    code: "STALE_REF",
  });
  assert.equal(await page.$eval("#query", (node) => node.value), "");
  await assert.rejects(dispatch({ ...fill, taskPolicy: null }), {
    code: "POLICY_BLOCKED",
  });
  assert.equal((await dispatch(fill)).result.dispatched, true);
  assert.equal(await page.$eval("#query", (node) => node.value), "Wikipedia");
  state = await snapshot();
  await page.type("#query", " by hand");
  await assert.rejects(
    dispatch(action(state, "fill", "#query", { text: "overwrite" })),
    { code: "STALE_REF" },
  );
  assert.equal(
    await page.$eval("#query", (node) => node.value),
    "Wikipedia by hand",
  );
  await assert.rejects(
    dispatch({ subaction: "evaluate", script: "alert(1)" }),
    { code: "UNSUPPORTED" },
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
  // Lose the transport reply after a real DOM effect. The command is consumed,
  // reports uncertainty and is never delivered again on the next pull.
  state = await snapshot();
  await client.close();
  connection = (await request("connect", { clientId: "renderer", epoch: 2 }))
    .body;
  const interrupted = new AbortController();
  const pending = channel.request(
    { command: action(state, "click", "#increment") },
    { effect: true, signal: interrupted.signal },
  );
  const uncertain = assert.rejects(pending, { code: "UNCERTAIN_OUTCOME" });
  const delivered = (await request("pull", connection)).body.command;
  const lost = await nativeDispatch(delivered.input.command);
  interrupted.abort();
  await uncertain;
  assert.equal(await page.$eval("output", (node) => node.textContent), "3");
  assert.equal(
    (await request("reply", { ...connection, id: delivered.id, result: lost }))
      .status,
    409,
  );
  const afterLoss = (await request("pull", connection)).body;
  assert.equal(afterLoss.command, null);
  assert.deepEqual(afterLoss.cancellations, [delivered.id]);
  assert.equal((await request("close", connection)).status, 200);
  assert.equal(
    (await request("connect", { clientId: "renderer", epoch: 1 })).status,
    409,
  );
  console.log(
    "PASS: authenticated host HTTP to isolated command channel, real click/fill, lost-effect uncertainty without replay, document and replay fences, manual input, policy requirement, fixed operations, credential exclusion",
  );
} finally {
  await client?.close();
  await browser?.close();
  channel.close();
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
