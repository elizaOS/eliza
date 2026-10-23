/** Real Chromium DOM and isolated realm; Android reply-proxy coverage is separate. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLocalAgentGateway } from "../../../packages/agent/native-host/gateway.mjs";
import { createSurfaceCommandChannel } from "../../../packages/agent/native-host/surface-channel.mjs";
import { connectSurfaceCommandClient } from "../../../packages/agent/native-host/surface-client.mjs";
import { buildTaskRuntime } from "../../../packages/app/scripts/build-consumer-task-runtime.mjs";
import { createSurfaceTaskHandler } from "../../../packages/os/browser/src/surface-task-handler.mjs";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import {
  GuidedWebsiteWorkflow,
  pageControls,
  pageView,
} from "../../plugin-personal-assistant/native-host/guided-website-workflow.mjs";

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
const certificates = await mkdtemp(join(tmpdir(), "eliza-surface-control-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(certificates, "key.pem"),
    "-out",
    join(certificates, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
  ],
  { stdio: "ignore" },
);
// Exercise the same immutable bundle consumed by product hosts, not a private
// test entry that can conceal missing public exports. Commit candidate sources
// before running this lane; native resources and the host bundle must agree.
const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceCommit = execFileSync(
  "git",
  ["-C", sourceRoot, "rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();
const runtimeModule = join(certificates, "task-runtime.mjs");
buildTaskRuntime(runtimeModule, { sourceRoot, sourceCommit });
const {
  commitFormHash,
  NativeSurfaceBrowserTarget,
  NativeTaskActuator,
  InteractiveTaskRuntime,
  SqliteInteractiveTaskStore,
} = await import(pathToFileURL(runtimeModule).href);
let paymentPosts = 0;
const posted = [];
const server = createServer(
  {
    key: await readFile(join(certificates, "key.pem")),
    cert: await readFile(join(certificates, "cert.pem")),
  },
  (req, res) => {
    if (req.method === "POST") {
      paymentPosts++;
      posted.push(req.url);
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><input id="query" aria-label="Search query"><input type="password" value="private-value"><button type="button" id="increment" onclick="document.querySelector('output').textContent++">Increment</button><output>0</output><label>Language<select id="language"><option value="opaque-en">English</option><option value="opaque-fr">French</option><option value="opaque-de">German</option><option value="opaque-disabled" disabled>Unavailable</option><option value="opaque-a">Ambiguous</option><option value="opaque-b">Ambiguous</option></select></label><form id="payment" action="/paid" method="post"><button id="pay">Pay bill</button></form><p id="receipt"></p><script>payment.addEventListener("submit",(event)=>{event.preventDefault();fetch("/paid",{method:"POST"}).then(()=>{receipt.textContent="Paid"})})</script>`,
    );
  },
);
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
    acceptInsecureCerts: true,
  });
  const page = await browser.newPage();
  const origin = `https://127.0.0.1:${server.address().port}`;
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
      {
        effect: ["click", "fill", "select", "scroll", "follow"].includes(
          command.subaction,
        ),
      },
    );
  const snapshot = async () =>
    (await dispatch({ subaction: "snapshot" })).result;
  const policy = {
    origin,
    expiresAt: Date.now() + 60000,
    targets: [
      { selector: "#increment", action: "click" },
      { selector: "#query", action: "fill" },
      { selector: "#language", action: "select" },
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
  // Read the shipped native asset, not only the imported Chromium source.
  // A stale generated asset used to omit the document scroll target entirely.
  await page.evaluate(() => {
    document.body.style.minHeight = "2200px";
  });
  state = await snapshot();
  const scrollTarget = state.elements.find(
    (item) => item.targetSelector === "html",
  );
  assert.equal(scrollTarget?.scrollOnly, true);
  assert.ok(scrollTarget.scroll.maxY > 0);
  // Native panes can have a fractional visual viewport below rounded innerHeight.
  // Guidance must not center the tall document before the authorized scroll.
  await mkdir(testOutputPath("native-scroll-guidance"), { recursive: true });
  for (const [width, height, scale] of [
    [800, 600, 1.001],
    [400, 191, 1.001],
    [400, 191, 1.25],
  ]) {
    await page.setViewport({ width, height });
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: scale });
    const viewport = await page.evaluate(() => ({
      layout: innerHeight,
      visual: visualViewport.height,
    }));
    assert.ok(viewport.visual < viewport.layout);
    state = await snapshot();
    const rootGuide = {
      kind: "show",
      id: "root-scroll-guidance",
      snapshotId: state.snapshotId,
      nodeId: state.elements.find((item) => item.targetSelector === "html").id,
      origin,
      expiresAt: Date.now() + 15000,
      text: "Scroll down to continue.",
      tone: "instruction",
    };
    assert.equal(
      (await dispatch({ subaction: "guide", guidance: rootGuide })).result
        .accepted,
      true,
    );
    assert.equal(
      await page.evaluate(() => scrollY),
      0,
      "Showing root guidance must not perform unjournaled scrolling",
    );
    const preview = {
      ...rootGuide,
      id: "root-scroll-preview",
      action: "scroll",
    };
    assert.equal(
      (await dispatch({ subaction: "guide", guidance: preview })).result
        .accepted,
      true,
    );
    const deadline = Date.now() + 5000;
    while (
      !(
        await dispatch({
          subaction: "guide",
          guidance: { ...preview, kind: "action-status" },
        })
      ).result.ready
    ) {
      assert.ok(Date.now() < deadline, "Root scroll preview must become ready");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      await page.evaluate(() => scrollY),
      0,
      "Preview must not move the page either",
    );
    await page.screenshot({
      path: testOutputPath(
        "native-scroll-guidance",
        `${width}-${height}-${scale}.png`,
      ),
    });
    await dispatch({ subaction: "guide", guidance: { kind: "hide" } });
  }
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await page.setViewport({ width: 800, height: 600 });
  state = await snapshot();
  const scroll = action(state, "scroll", "html", {
    direction: "down",
    taskPolicy: {
      ...policy,
      targets: [{ selector: "html", action: "scroll" }],
    },
  });
  assert.equal((await dispatch(scroll)).result.dispatched, true);
  assert.ok(await page.evaluate(() => scrollY > 0));
  await assert.rejects(dispatch(scroll), { code: "STALE_REF" });
  await page.evaluate(() => {
    document.body.style.minHeight = "";
    scrollTo(0, 0);
  });
  state = await snapshot();
  const click = action(state, "click", "#increment");
  const guide = (guidance) => dispatch({ subaction: "guide", guidance });
  const shown = {
    kind: "show",
    id: "step-1",
    snapshotId: state.snapshotId,
    nodeId: click.nodeId,
    origin,
    expiresAt: Date.now() + 15000,
    text: "I will select Increment.",
    assistantName: "Test helper",
    action: "click",
  };
  assert.equal((await guide(shown)).result.accepted, true);
  const status = {
    kind: "action-status",
    id: shown.id,
    snapshotId: shown.snapshotId,
    nodeId: shown.nodeId,
    action: shown.action,
  };
  const readyDeadline = Date.now() + 5000;
  while (!(await guide(status)).result.ready) {
    assert.ok(
      Date.now() < readyDeadline,
      "The native action preview must become visible and ready",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    await page.evaluate(() => typeof globalThis.__elizaPageGuidanceV1),
    "undefined",
  );
  assert.equal((await guide({ kind: "pause" })).result.paused, true);
  assert.equal((await guide(status)).result.ready, false);
  assert.equal(
    (await guide({ ...shown, restore: true })).result.accepted,
    true,
  );
  assert.equal((await guide({ kind: "hide" })).result.visible, false);
  assert.equal(
    (await guide({ ...shown, snapshotId: "retired" })).result.reason,
    "stale-observation",
  );
  await assert.rejects(guide({ ...shown, tone: "offer", answers: [] }), {
    code: "INVALID_REQUEST",
  });
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
  assert.ok(
    !JSON.stringify(state).includes("opaque-fr"),
    "Internal option values stay in the page",
  );
  for (const text of ["Missing", "Unavailable", "Ambiguous"])
    await assert.rejects(
      dispatch(action(state, "select", "#language", { text })),
      { code: "POLICY_BLOCKED" },
    );
  const select = action(state, "select", "#language", { text: "German" });
  await dispatch({ ...select, validateOnly: true });
  assert.equal(
    await page.$eval("#language", (node) => node.selectedOptions[0].label),
    "English",
  );
  assert.equal((await dispatch(select)).result.dispatched, true);
  assert.equal(
    await page.$eval("#language", (node) => node.selectedOptions[0].label),
    "German",
  );
  await assert.rejects(dispatch(select), { code: "STALE_REF" });
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
  // The task adapter uses the same real isolated page, with a product-style
  // UUID page identity. Only the native reply proxy is represented by this port.
  let selected = true,
    failCleanup = false;
  const pageId = "page-9d7a8c01";
  const nativePage = { id: pageId, url: origin, isCurrent: () => selected };
  const nativeControl = async (_page, input, signal) => {
    signal?.throwIfAborted();
    const reply = await nativeDispatch(
      input.command,
      input.documentId ? { documentId: input.documentId } : {},
    );
    if (reply.result?.error)
      throw Object.assign(new Error(reply.result.error.message), {
        code: reply.result.error.kind,
      });
    return { ...reply, frameScope: "main" };
  };
  const taskHandler = createSurfaceTaskHandler({
    getPage: async (id) => {
      if (id !== undefined) assert.equal(id, pageId);
      if (!selected)
        throw Object.assign(new Error("Parked"), { code: "STALE_REF" });
      return nativePage;
    },
    listPages: async () => [{ id: pageId }],
    control: nativeControl,
    cleanup: async (_id, kind) => {
      const result = (
        await nativeControl(nativePage, {
          command: { subaction: "guide", guidance: { kind } },
        })
      ).result;
      if (failCleanup) {
        failCleanup = false;
        throw Object.assign(new Error("Cleanup context changed"), {
          code: "STALE_REF",
        });
      }
      return result;
    },
    isCurrent: () => true,
  });
  client = await connectSurfaceCommandClient({
    clientId: "task-renderer",
    epoch: 3,
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
    handleCommand: taskHandler,
  });
  await assert.rejects(
    channel.request(
      { type: "current-page", id: "retired-connection" },
      { effect: false, connectionId: connection.connectionId },
    ),
    { code: "STALE_REF" },
  );
  const surfaceTarget = new NativeSurfaceBrowserTarget(channel);
  assert.equal((await surfaceTarget.currentPage()).tabId, pageId);
  assert.ok(surfaceTarget.getProfileId().startsWith("embedded:"));
  const context = {
    actorId: "synthetic-owner",
    accountId: "synthetic-account",
    agentId: "synthetic-agent",
    taskId: "surface-task",
    epoch: 1,
  };
  let requestId = 0;
  const taskRequest = (message, effect = false) =>
    channel.request(
      { id: `surface-request-${++requestId}`, ...message },
      { effect },
    );
  const binding = {
    ...context,
    tabId: pageId,
    bindingRevision: 1,
    origin,
    expiresAt: Date.now() + 60000,
    revoked: false,
    assistantName: "Test helper",
    targets: policy.targets,
  };
  assert.equal((await surfaceTarget.bindTask(binding)).bound, true);
  const taskSnapshot = async () =>
    (
      await surfaceTarget.execute(
        { subaction: "snapshot", id: pageId },
        { taskContext: context },
      )
    ).value.result;
  let observed = await taskSnapshot();
  assert.equal(observed.frames[0].documentId, ready.documentId);
  assert.equal(observed.frames[0].complete, true);
  assert.ok(!JSON.stringify(observed).includes("private-value"));
  const taskAction = (subaction, target, extra = {}) => ({
    type: "command",
    command: {
      subaction,
      id: pageId,
      taskContext: context,
      selector: observed.frames[0].elements.find(
        (element) => element.targetSelector === target,
      ).selector,
      expectedSelector: target,
      ...extra,
    },
  });
  await assert.rejects(
    taskRequest(
      {
        ...taskAction("click", "#increment"),
        command: {
          ...taskAction("click", "#increment").command,
          taskContext: { ...context, accountId: "another" },
        },
      },
      true,
    ),
    { code: "POLICY_BLOCKED" },
  );
  const increment = taskAction("click", "#increment");
  assert.equal(
    (
      await surfaceTarget.execute(increment.command, {
        taskContext: context,
        expectedSelector: "#increment",
      })
    ).value.result.dispatched,
    true,
  );
  assert.equal(await page.$eval("output", (node) => node.textContent), "4");
  await assert.rejects(taskRequest(increment, true), { code: "STALE_REF" });
  observed = await taskSnapshot();
  assert.equal(
    (
      await taskRequest(
        taskAction("fill", "#query", {
          text: "Wikipedia from the task adapter",
        }),
        true,
      )
    ).dispatched,
    true,
  );
  assert.equal(
    await page.$eval("#query", (node) => node.value),
    "Wikipedia from the task adapter",
  );
  observed = await taskSnapshot();
  assert.equal(
    (
      await surfaceTarget.execute(
        taskAction("select", "#language", { value: "English" }).command,
        { taskContext: context, expectedSelector: "#language" },
      )
    ).value.result.dispatched,
    true,
  );
  assert.equal(
    await page.$eval("#language", (node) => node.selectedOptions[0].label),
    "English",
  );
  observed = await taskSnapshot();
  selected = false;
  await assert.rejects(taskRequest(taskAction("click", "#increment"), true), {
    code: "STALE_REF",
  });
  assert.equal(await page.$eval("output", (node) => node.textContent), "4");
  selected = true;
  const owner = {
    actorId: context.actorId,
    agentId: context.agentId,
    connector: { source: "fixture", accountId: context.accountId },
  };
  const task = {
    id: context.taskId,
    owner,
    epoch: 2,
    revision: 1,
    status: "waiting",
    authorization: { state: "active", decisionId: "fixture-authority" },
    allowedOrigins: [origin],
    allowedCapabilities: ["browser.click", "browser.select", "browser.fill"],
    operations: [],
  };
  const actuator = new NativeTaskActuator({
    target: surfaceTarget,
    getTask: () => task,
    policy: () => ({
      tabId: pageId,
      origin,
      leaseMs: 60000,
      targets: policy.targets,
    }),
    nextBindingRevision: () => 2,
    resolveValue: async (ref) => {
      if (ref === "public-query") return "Exact public query";
      assert.equal(ref, "public-choice-french");
      return "French";
    },
    verify: async (proposal, before, after) =>
      proposal.capability === "browser.fill"
        ? "succeeded"
        : proposal.capability === "browser.select"
          ? after.elements
              .find((e) => e.targetSelector === "#language")
              ?.options?.find((o) => o.selected)?.label === "French"
            ? "succeeded"
            : "unknown"
          : before.text.includes("4") &&
              after.text.includes("5") &&
              after.clickReadback?.targetRef === proposal.targetRef &&
              after.clickReadback?.synchronousTextChange === true
            ? "succeeded"
            : "unknown",
    recordEvidence: async () => "fixture-real-page-readback",
  });
  const actuatorSignal = new AbortController().signal;
  task.observation = await actuator.observe({
    owner,
    taskId: task.id,
    signal: actuatorSignal,
  });
  const actual = actuator.readObservation(task.id, owner);
  const proposal = {
    id: "actuator-click",
    taskId: task.id,
    epoch: task.epoch,
    authorizationId: task.authorization.decisionId,
    observationId: task.observation.id,
    observationVersion: task.observation.version,
    inputRevision: task.observation.inputRevision,
    targetRef: actual.snapshot.elements.find(
      (element) => element.targetSelector === "#increment",
    ).selector,
    expectedSelector: "#increment",
    capability: "browser.click",
    expiresAt: Date.now() + 10000,
  };
  task.operations.push({ status: "dispatched", proposal });
  const outcome = await actuator.execute(proposal, {
    owner,
    signal: actuatorSignal,
    isCurrent: () => true,
  });
  assert.deepEqual(outcome, {
    status: "succeeded",
    evidenceRef: "fixture-real-page-readback",
  });
  assert.equal(await page.$eval("output", (node) => node.textContent), "5");
  task.observation = await actuator.observe({
    owner,
    taskId: task.id,
    signal: actuatorSignal,
  });
  const selectObservation = actuator.readObservation(task.id, owner);
  assert.equal(
    selectObservation.snapshot.clickReadback,
    undefined,
    "The next task observation cannot replay click result evidence",
  );
  const plannerView = pageView(
    selectObservation.snapshot,
    pageControls(selectObservation.snapshot),
  );
  const language = plannerView.controls.find(
    (control) => control.label === "Language",
  );
  assert.deepEqual(
    language.options.map((option) => option.label),
    ["English", "French", "German", "Unavailable", "Ambiguous", "Ambiguous"],
  );
  assert.equal(
    language.options.find((option) => option.label === "Unavailable").disabled,
    true,
  );
  assert.equal(language.options.filter((option) => option.selected).length, 1);
  assert.equal(JSON.stringify(plannerView).includes("opaque-"), false);
  assert.equal(JSON.stringify(plannerView).includes("private-value"), false);
  const selectProposal = {
    ...proposal,
    id: "actuator-select",
    capability: "browser.select",
    valueRef: "public-choice-french",
    observationId: task.observation.id,
    observationVersion: task.observation.version,
    inputRevision: task.observation.inputRevision,
    targetRef: selectObservation.snapshot.elements.find(
      (e) => e.targetSelector === "#language",
    ).selector,
    expectedSelector: "#language",
  };
  task.operations.push({ status: "dispatched", proposal: selectProposal });
  assert.equal(
    (
      await actuator.execute(selectProposal, {
        owner,
        signal: actuatorSignal,
        isCurrent: () => true,
      })
    ).status,
    "succeeded",
  );
  assert.equal(
    await page.$eval("#language", (node) => node.selectedOptions[0].label),
    "French",
  );
  for (const rewrite of [false, true]) {
    await page.$eval(
      "#query",
      (node, rewrite) => {
        node.oninput = rewrite
          ? () => {
              node.value = "Rewritten by website";
            }
          : null;
      },
      rewrite,
    );
    task.observation = await actuator.observe({
      owner,
      taskId: task.id,
      signal: actuatorSignal,
    });
    const read = actuator.readObservation(task.id, owner);
    const fillProposal = {
      ...proposal,
      id: `fill-readback-${rewrite}`,
      capability: "browser.fill",
      valueRef: "public-query",
      observationId: task.observation.id,
      observationVersion: task.observation.version,
      inputRevision: task.observation.inputRevision,
      targetRef: read.snapshot.elements.find(
        (e) => e.targetSelector === "#query",
      ).selector,
      expectedSelector: "#query",
      expiresAt: Date.now() + 10000,
    };
    task.operations.push({ status: "dispatched", proposal: fillProposal });
    const result = await actuator.execute(fillProposal, {
      owner,
      signal: actuatorSignal,
      isCurrent: () => true,
    });
    assert.equal(
      result.status,
      rewrite ? "unknown" : "succeeded",
      "A website rewrite cannot pass even an overly permissive host verifier",
    );
    assert.equal(
      await page.$eval("#query", (node) => node.value),
      rewrite ? "Rewritten by website" : "Exact public query",
    );
    const again = await actuator.observe({
      owner,
      taskId: task.id,
      signal: actuatorSignal,
    });
    task.observation = again;
    const snapshot = actuator.readObservation(task.id, owner).snapshot;
    assert.equal(
      snapshot.inputReadback,
      undefined,
      "Fill comparison is consumed by its first readback",
    );
    assert.ok(
      !JSON.stringify(snapshot).includes("Exact public query") &&
        !JSON.stringify(snapshot).includes("Rewritten by website"),
    );
  }
  await page.$eval("#query", (node) => {
    node.oninput = null;
  });
  const renewedContext = { ...context, epoch: 2 };
  observed = (
    await surfaceTarget.execute(
      { subaction: "snapshot", id: pageId },
      { taskContext: renewedContext },
    )
  ).value.result;
  failCleanup = true;
  await assert.rejects(
    surfaceTarget.execute(taskAction("click", "#increment").command, {
      taskContext: renewedContext,
      expectedSelector: "#increment",
    }),
    { kind: "UNCERTAIN_OUTCOME" },
  );
  assert.equal(
    await page.$eval("output", (node) => node.textContent),
    "6",
    "Cleanup failure must not hide the real effect",
  );
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.id = "planned-portal";
    a.href = "#billing-portal";
    a.textContent = "Payment portal";
    a.onclick = () => {
      throw new Error("Follow must not activate the click handler");
    };
    document.body.append(a);
    window.addEventListener("hashchange", () => {
      if (location.hash === "#billing-portal") {
        const status = document.createElement("p");
        status.textContent = "Portal opened";
        document.body.append(status);
      }
    });
  });
  // Drive the shared planned-action workflow through the real durable task
  // runtime, HTTP transport and DOM. The deterministic planner is not LLM proof.
  failCleanup = false;
  const db = new DatabaseSync(join(certificates, "planned-actions.sqlite"));
  db.exec("PRAGMA synchronous=FULL");
  let workflow,
    runtime,
    bindingRevision = 2,
    permitted = false;
  // A navigation can retire Android's isolated-world reply before it reaches
  // the host. Lose only that acknowledgement after the real DOM operation.
  let lostFollowReplies = 0,
    followFault = "lost-reply";
  const followTarget = Object.create(surfaceTarget);
  followTarget.execute = async (command, options) => {
    if (command.subaction === "follow" && followFault === "no-navigation")
      throw Object.assign(new Error("No dispatch receipt"), {
        kind: "UNCERTAIN_OUTCOME",
      });
    const result = await surfaceTarget.execute(command, options);
    if (command.subaction === "follow") {
      lostFollowReplies++;
      await page.waitForFunction(() => location.hash === "#billing-portal");
      if (followFault === "wrong-destination")
        await page.evaluate(() => history.replaceState(null, "", "#unrelated"));
      if (followFault === "revoked") {
        const active = runtime.get(plannedTask.id);
        runtime.control(active.id, active.revision, "pause");
      }
      throw Object.assign(new Error("Navigation retired its native reply"), {
        kind: "UNCERTAIN_OUTCOME",
      });
    }
    return result;
  };
  const plannedActuator = new NativeTaskActuator({
    target: followTarget,
    getTask: (id) => runtime.get(id),
    policy: (current) => ({
      tabId: pageId,
      origin,
      leaseMs: 60000,
      targets: workflow?.actionTargets(current) ?? [],
    }),
    nextBindingRevision: () => ++bindingRevision,
    resolveValue: async (ref) => {
      assert.equal(ref, "public-german");
      return "German";
    },
    verify: async (proposal, before, after) =>
      proposal.capability === "browser.follow"
        ? after.url === `${origin}/#billing-portal`
          ? "succeeded"
          : "unknown"
        : proposal.capability === "browser.select"
          ? after.elements
              .find((e) => e.targetSelector === "#language")
              ?.options.find((o) => o.selected)?.label === "German"
            ? "succeeded"
            : "unknown"
          : before.text.includes("6") && after.text.includes("7")
            ? "succeeded"
            : "unknown",
    recordEvidence: async () => "fixture-planned-action-readback",
  });
  runtime = new InteractiveTaskRuntime({
    owner,
    store: new SqliteInteractiveTaskStore(db),
    actuator: plannedActuator,
  });
  let plannedTask = runtime.create({
    id: "planned-native-flow",
    goalRef: "select-and-click",
    allowedOrigins: [origin],
    allowedCapabilities: ["browser.select", "browser.click", "browser.follow"],
    authorization: {
      decisionId: "planned-authority",
      policyRevision: "fixture-v1",
      state: "active",
      decidedAt: new Date().toISOString(),
      revokedAt: null,
    },
  });
  workflow = new GuidedWebsiteWorkflow({
    runtime,
    actuator: plannedActuator,
    taskId: plannedTask.id,
    authorizeAction: () => permitted,
    planStep: ({ page: view }) => {
      const choice = view.controls.find((c) => c.options);
      if (!choice.options.some((o) => o.label === "German" && o.selected))
        return {
          status: "act",
          kind: "agent-action",
          action: "select",
          ref: choice.ref,
          valueRef: "public-german",
          message: "Choose German",
        };
      if (!view.text.includes("7"))
        return {
          status: "act",
          kind: "agent-action",
          action: "click",
          ref: view.controls.find((c) => c.label === "Increment").ref,
          message: "Increment once",
        };
      if (!view.text.includes("Portal opened"))
        return {
          status: "act",
          kind: "agent-action",
          action: "follow",
          ref: view.controls.find((c) => c.label === "Payment portal").ref,
          message: "Open the payment portal",
        };
      return { status: "done", message: "Observed all requested changes" };
    },
  });
  try {
    plannedTask = await runtime.observe(
      plannedTask.id,
      plannedTask.revision,
      false,
    );
    assert.equal(
      (await workflow.refresh()).kind,
      "blocked",
      "A model plan cannot grant action authority",
    );
    const lifetime = new AbortController();
    workflow.signal = lifetime.signal;
    let entered;
    const checking = new Promise((resolve) => {
      entered = resolve;
    });
    workflow.authorizeAction = () => {
      entered();
      return new Promise(() => {});
    };
    const waiting = workflow.refresh();
    await checking;
    const beforePause = runtime.get(plannedTask.id);
    runtime.control(beforePause.id, beforePause.revision, "pause");
    lifetime.abort();
    await assert.rejects(waiting, /authorization changed/i);
    await runtime.settle(plannedTask.id);
    assert.equal(
      runtime.get(plannedTask.id).operations.length,
      0,
      "Aborted policy work cannot dispatch",
    );
    workflow.signal = new AbortController().signal;
    workflow.authorizeAction = (_input, context) => {
      assert.equal(context.signal, workflow.signal);
      assert.equal(context.taskId, plannedTask.id);
      return permitted;
    };
    const paused = runtime.get(plannedTask.id);
    await runtime.observe(paused.id, paused.revision, true);
    permitted = true;
    let decision = await workflow.refresh();
    assert.equal(decision.kind, "agent-action");
    permitted = false;
    assert.equal(
      (await workflow.executeAction(decision.offerKey)).kind,
      "blocked",
    );
    assert.equal(
      runtime.get(plannedTask.id).operations.length,
      0,
      "Revoked host permission prevents dispatch",
    );
    permitted = true;
    decision = await workflow.refresh();
    await page.select("#language", "opaque-en");
    decision = await workflow.executeAction(decision.offerKey);
    assert.equal(
      await page.$eval("#language", (n) => n.selectedOptions[0].label),
      "English",
      "A changed page is replanned without an effect",
    );
    assert.equal(runtime.get(plannedTask.id).operations.length, 0);
    decision = await workflow.executeAction(decision.offerKey);
    assert.equal(
      await page.$eval("#language", (n) => n.selectedOptions[0].label),
      "German",
    );
    assert.equal(decision.kind, "agent-action");
    decision = await workflow.executeAction(decision.offerKey);
    assert.equal(decision.kind, "agent-action");
    assert.equal(await page.$eval("output", (n) => n.textContent), "7");
    decision = await workflow.executeAction(decision.offerKey);
    assert.equal(
      decision.kind,
      "done",
      JSON.stringify({ decision, task: runtime.get(plannedTask.id) }),
    );
    assert.equal(page.url(), `${origin}/#billing-portal`);
    assert.equal(
      lostFollowReplies,
      1,
      "Lost navigation replies must never replay follow",
    );
    assert.deepEqual(
      runtime.get(plannedTask.id).operations.map((o) => o.status),
      ["succeeded", "succeeded", "succeeded"],
    );
    for (const mode of ["no-navigation", "wrong-destination", "revoked"]) {
      followFault = mode;
      await page.evaluate(() => history.replaceState(null, "", "/"));
      plannedTask = runtime.create({
        id: `uncertain-follow-${mode}`,
        goalRef: "open-portal",
        allowedOrigins: [origin],
        allowedCapabilities: ["browser.follow"],
        authorization: {
          decisionId: `follow-${mode}`,
          policyRevision: "fixture-v1",
          state: "active",
          decidedAt: new Date().toISOString(),
          revokedAt: null,
        },
      });
      workflow = new GuidedWebsiteWorkflow({
        runtime,
        actuator: plannedActuator,
        taskId: plannedTask.id,
        authorizeAction: () => true,
        planStep: ({ page: view }) => ({
          status: "act",
          kind: "agent-action",
          action: "follow",
          ref: view.controls.find((c) => c.label === "Payment portal").ref,
          message: "Open the portal",
        }),
      });
      plannedTask = await runtime.observe(
        plannedTask.id,
        plannedTask.revision,
        false,
      );
      const offered = await workflow.refresh();
      assert.equal(offered.kind, "agent-action");
      const before = lostFollowReplies;
      await workflow.executeAction(offered.offerKey);
      const operations = runtime.get(plannedTask.id).operations;
      assert.equal(operations.length, 1, mode);
      assert.notEqual(operations[0].status, "succeeded", mode);
      assert.equal(
        lostFollowReplies - before,
        mode === "no-navigation" ? 0 : 1,
        "No follow replay",
      );
    }
  } finally {
    await plannedActuator.quiesce({ owner, taskId: plannedTask.id });
    db.close();
  }
  console.log(
    "PASS: planned select and click through durable SQLite task runtime, host permission withdrawal and stale-page replan without dispatch",
  );
  // A commit control stays with the person unless the host spends a grant
  // for her yes to that one control in this observation; the grant is
  // single use and the page reports the commit as consented.
  const payContext = { ...context, epoch: 5 };
  assert.equal(
    (
      await surfaceTarget.bindTask({
        ...binding,
        ...payContext,
        bindingRevision: 100,
        expiresAt: Date.now() + 60000,
        targets: [{ selector: "#pay", action: "click" }],
      })
    ).bound,
    true,
  );
  const payObservation = async () => {
    observed = (
      await surfaceTarget.execute(
        { subaction: "snapshot", id: pageId },
        { taskContext: payContext },
      )
    ).value.result;
    return taskAction("click", "#pay").command;
  };
  const payGrant = (command, grantId) => ({
    grantId,
    taskId: payContext.taskId,
    epoch: payContext.epoch,
    origin,
    targetRef: command.selector,
    selector: "#pay",
    subaction: "click",
    expiresAt: Date.now() + 30000,
  });
  let payCommand = await payObservation();
  await assert.rejects(
    surfaceTarget.execute(payCommand, {
      taskContext: payContext,
      expectedSelector: "#pay",
    }),
    { kind: "POLICY_BLOCKED" },
  );
  assert.equal(paymentPosts, 0);
  payCommand = await payObservation();
  // A grant for another observation of the same control is refused.
  await assert.rejects(
    surfaceTarget.execute(payCommand, {
      taskContext: payContext,
      expectedSelector: "#pay",
      commitGrant: {
        ...payGrant(payCommand, "pay-stale"),
        targetRef: "00000000-0000-4000-8000-000000000000:0:1",
      },
    }),
    { kind: "POLICY_BLOCKED" },
  );
  payCommand = await payObservation();
  const paid = payGrant(payCommand, "pay-yes");
  assert.equal(
    (
      await surfaceTarget.execute(payCommand, {
        taskContext: payContext,
        expectedSelector: "#pay",
        commitGrant: paid,
      })
    ).value.result.dispatched,
    true,
  );
  await page.waitForFunction(
    () => document.querySelector("#receipt").textContent === "Paid",
  );
  assert.equal(paymentPosts, 1);
  payCommand = await payObservation();
  assert.deepEqual(observed.frames[0].consentedCommit, {
    grantId: "pay-yes",
    kind: "submit",
    formHash: commitFormHash([]),
  });
  assert.equal(observed.frames[0].effectViolation, undefined);
  // The spent grant cannot commit again, even for a fresh observation.
  await assert.rejects(
    surfaceTarget.execute(payCommand, {
      taskContext: payContext,
      expectedSelector: "#pay",
      commitGrant: { ...paid, targetRef: payCommand.selector },
    }),
    { kind: "POLICY_BLOCKED" },
  );
  assert.equal(paymentPosts, 1);
  console.log(
    "PASS: embedded commit control blocked without a grant; one host grant commits once, is reported as consented, and cannot be replayed",
  );
  // Only the granted control's own submit is consented. A form whose page
  // script sends it with fetch, so nothing leaves this document.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<form id="transfer" action="/transfer" method="post"><button id="send">Send transfer</button><button id="alt" formaction="/exfil">Other</button></form>',
    );
    const transfer = document.querySelector("#transfer");
    transfer.addEventListener("submit", (event) => {
      event.preventDefault();
      const submitter = event.submitter;
      fetch(
        submitter?.hasAttribute("formaction")
          ? submitter.formAction
          : transfer.action,
        { method: "POST" },
      );
    });
  });
  const sendClick = async (epoch, onclick, grantFields = {}) => {
    await page.evaluate((script) => {
      document.querySelector("#send").setAttribute("onclick", script);
    }, onclick);
    const sendContext = { ...context, epoch };
    assert.equal(
      (
        await surfaceTarget.bindTask({
          ...binding,
          ...sendContext,
          bindingRevision: 100 + epoch,
          expiresAt: Date.now() + 60000,
          targets: [{ selector: "#send", action: "click" }],
        })
      ).bound,
      true,
    );
    const read = async () =>
      (
        await surfaceTarget.execute(
          { subaction: "snapshot", id: pageId },
          { taskContext: sendContext },
        )
      ).value.result.frames[0];
    const frame = await read();
    const selector = frame.elements.find(
      (element) => element.targetSelector === "#send",
    ).selector;
    const sendCommand = {
      subaction: "click",
      id: pageId,
      taskContext: sendContext,
      selector,
      expectedSelector: "#send",
    };
    assert.equal(
      (
        await surfaceTarget.execute(sendCommand, {
          taskContext: sendContext,
          expectedSelector: "#send",
          commitGrant: {
            grantId: `send-${epoch}`,
            taskId: sendContext.taskId,
            epoch,
            origin,
            targetRef: selector,
            selector: "#send",
            subaction: "click",
            expiresAt: Date.now() + 30000,
            ...grantFields,
          },
        })
      ).value.result.dispatched,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    return read();
  };
  // requestSubmit(alt): the other submitter's formaction is refused.
  let sent = await sendClick(
    6,
    "event.preventDefault();this.form.requestSubmit(alt)",
  );
  assert.equal(sent.effectViolation, "submit");
  assert.equal(sent.consentedCommit, undefined);
  // A script click on the other submitter is refused too.
  sent = await sendClick(7, "event.preventDefault();alt.click()");
  assert.equal(sent.effectViolation, "submit");
  assert.equal(sent.consentedCommit, undefined);
  // A script form.submit() sends no submit event and is not consented.
  sent = await sendClick(8, "event.preventDefault();this.form.submit()");
  assert.equal(sent.effectViolation, "submit");
  assert.equal(sent.consentedCommit, undefined);
  assert.ok(!posted.includes("/exfil") && !posted.includes("/transfer"));
  // A submit with no submitter, when the granted button is the form's
  // default button and overrides nothing, is consented.
  sent = await sendClick(9, "event.preventDefault();this.form.requestSubmit()");
  assert.equal(sent.effectViolation, undefined);
  assert.deepEqual(sent.consentedCommit, {
    grantId: "send-9",
    kind: "submit",
    formHash: commitFormHash([]),
  });
  // The granted submitter itself is consented.
  sent = await sendClick(10, "");
  assert.equal(sent.effectViolation, undefined);
  assert.deepEqual(sent.consentedCommit, {
    grantId: "send-10",
    kind: "submit",
    formHash: commitFormHash([]),
  });
  assert.deepEqual(
    posted.filter((path) => path !== "/paid"),
    ["/transfer", "/transfer"],
  );
  // A default button that overrides the action: no submitter is refused.
  await page.evaluate(() =>
    document.querySelector("#send").setAttribute("formaction", "/transfer"),
  );
  sent = await sendClick(
    11,
    "event.preventDefault();this.form.requestSubmit()",
  );
  assert.equal(sent.effectViolation, "submit");
  assert.equal(sent.consentedCommit, undefined);
  assert.ok(!posted.includes("/exfil"));
  console.log(
    "PASS: a consented commit is only the granted submitter's own submit; another submitter, form.submit() and an overriding implicit submit are refused",
  );
  // A consented commit is bound to its exact request and form contents.
  await page.evaluate(() => {
    const send = document.querySelector("#send");
    send.removeAttribute("formaction");
    send.insertAdjacentHTML(
      "beforebegin",
      '<input name="amount" aria-label="Amount" value="12">',
    );
  });
  const reviewed = commitFormHash([["amount", "12"]]);
  // A same-site fetch to another path than the form's action is not the
  // granted request: it is reported, with no consented commit.
  sent = await sendClick(
    12,
    "event.preventDefault();fetch('/exfil-fetch',{method:'POST'})",
  );
  assert.equal(sent.effectViolation, "request");
  assert.equal(sent.consentedCommit, undefined);
  // ... nor is a request the grant declares a target for, to another path.
  sent = await sendClick(
    13,
    "event.preventDefault();fetch('/exfil-fetch',{method:'POST'})",
    { requestTarget: { path: "/charge", method: "POST" } },
  );
  assert.equal(sent.effectViolation, "request");
  assert.equal(sent.consentedCommit, undefined);
  // The declared request target is consented.
  sent = await sendClick(
    14,
    "event.preventDefault();fetch('/charge',{method:'POST'})",
    { requestTarget: { path: "/charge", method: "POST" } },
  );
  assert.equal(sent.effectViolation, undefined);
  assert.deepEqual(sent.consentedCommit, {
    grantId: "send-14",
    kind: "request",
  });
  // Without a formHash the page reports the hash of the form data sent, and
  // it equals the host helper's for the same fields.
  sent = await sendClick(15, "");
  assert.equal(sent.effectViolation, undefined);
  assert.equal(sent.consentedCommit.formHash, reviewed);
  // A matching formHash is consented.
  sent = await sendClick(16, "", { formHash: reviewed });
  assert.equal(sent.effectViolation, undefined);
  assert.deepEqual(sent.consentedCommit, {
    grantId: "send-16",
    kind: "submit",
    formHash: reviewed,
  });
  const transfers = posted.filter((path) => path === "/transfer").length;
  // A field value changed after her yes, or an added hidden input, is refused.
  sent = await sendClick(17, "this.form.amount.value='9999'", {
    formHash: reviewed,
  });
  assert.equal(sent.effectViolation, "submit");
  assert.equal(sent.consentedCommit, undefined);
  await page.evaluate(() => {
    document.querySelector("#transfer").amount.value = "12";
  });
  sent = await sendClick(
    18,
    "const extra=document.createElement('input');extra.type='hidden';extra.name='to';extra.value='mallory';this.form.append(extra)",
    { formHash: reviewed },
  );
  assert.equal(sent.effectViolation, "submit");
  assert.equal(sent.consentedCommit, undefined);
  assert.equal(posted.filter((path) => path === "/transfer").length, transfers);
  await page.evaluate(() =>
    document.querySelector('#transfer input[name="to"]').remove(),
  );
  // A script form.submit() into a new window is reported.
  sent = await sendClick(
    19,
    "event.preventDefault();this.form.target='_blank';this.form.submit();this.form.target=''",
  );
  assert.equal(sent.effectViolation, "submit");
  assert.equal(sent.consentedCommit, undefined);
  console.log(
    "PASS: a consented commit is bound to its request and form contents; another path, a changed field, an added hidden input and a form.submit() into a new window are refused or reported, and the host and page form hashes agree",
  );
  await taskHandler.close();
  // The shipped isolated channel follows the observed URL without running a
  // payment-labelled anchor's click handler. It takes no caller-provided URL.
  const linkDispatch = async (command) => {
    const reply = await nativeDispatch(command);
    if (reply.result.error)
      throw Object.assign(new Error(reply.result.error.message), {
        code: reply.result.error.kind,
      });
    return reply;
  };
  const linkSnapshot = async () =>
    (await linkDispatch({ subaction: "snapshot" })).result;
  await page.evaluate(() => {
    document.body.innerHTML = `<a id="portal" href="/billing-portal" onclick="fetch('/unexpected-payment', {method:'POST'})">Payment portal</a>`;
  });
  const followPolicy = {
    origin,
    expiresAt: Date.now() + 60000,
    targets: [{ selector: "#portal", action: "follow" }],
  };
  const follow = (state) =>
    action(state, "follow", "#portal", { taskPolicy: followPolicy });
  state = await linkSnapshot();
  await page.evaluate(
    () => (document.querySelector("#portal").href = "/different"),
  );
  await assert.rejects(linkDispatch(follow(state)), { code: "STALE_REF" });
  for (const href of [
    "javascript:alert(1)",
    "https://other.example/portal",
    `https://user:password@127.0.0.1:${server.address().port}/portal`,
  ]) {
    await page.evaluate(
      (href) => (document.querySelector("#portal").href = href),
      href,
    );
    state = await linkSnapshot();
    await assert.rejects(linkDispatch(follow(state)), {
      code: "POLICY_BLOCKED",
    });
  }
  await page.evaluate(() => {
    const a = document.querySelector("#portal");
    a.href = "/billing-portal";
    a.download = "receipt";
  });
  state = await linkSnapshot();
  await assert.rejects(linkDispatch(follow(state)), { code: "POLICY_BLOCKED" });
  await page.evaluate(() => {
    const a = document.querySelector("#portal");
    a.removeAttribute("download");
    a.target = "_blank";
  });
  state = await linkSnapshot();
  await assert.rejects(linkDispatch(follow(state)), { code: "POLICY_BLOCKED" });
  await page.evaluate(() =>
    document.querySelector("#portal").removeAttribute("target"),
  );
  state = await linkSnapshot();
  const postsBeforeFollow = paymentPosts;
  const navigation = page.waitForNavigation();
  const followed = await linkDispatch(follow(state));
  assert.equal(followed.result.dispatched, true);
  assert.equal(followed.result.requiresReadback, true);
  await navigation;
  assert.equal(page.url(), `${origin}/billing-portal`);
  assert.equal(
    paymentPosts,
    postsBeforeFollow,
    "Following the link must not execute its payment handler",
  );
  console.log(
    "PASS: observed same-origin link navigation without click handlers, with stale URL, credential, scheme, origin, download and new-window refusal",
  );

  console.log(
    "PASS: NativeTaskActuator readback, cleanup uncertainty, bound embedded task adapter and authenticated host HTTP to isolated command channel, real click/fill/select with visible preview and option-label readback, lost-effect uncertainty without replay, document and replay fences, manual input, policy requirement, fixed operations, credential exclusion",
  );
} finally {
  await client?.close();
  await browser?.close();
  channel.close();
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await rm(certificates, { recursive: true, force: true });
}
