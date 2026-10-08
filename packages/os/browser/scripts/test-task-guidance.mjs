/** Real Chromium page + native-message handler; socket/Android remain separate. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { createCommandHandler } from "../src/command-handler.mjs";

const require = createRequire(
  import.meta.resolve("@elizaos/plugin-browser/package.json"),
);
const { default: puppeteer } = require("puppeteer-core");
if (!process.env.ELIZA_BROWSER_EXECUTABLE)
  throw new Error("Set ELIZA_BROWSER_EXECUTABLE");
const root = mkdtempSync(join(tmpdir(), "eliza-guide-host-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, "key.pem"),
    "-out",
    join(root, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
  ],
  { stdio: "ignore" },
);
const server = createServer(
  {
    key: readFileSync(join(root, "key.pem")),
    cert: readFileSync(join(root, "cert.pem")),
  },
  (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><style>button{margin:100px;padding:20px;font:24px system-ui}</style><button id="target" type="button" onclick="window.clicks++">Continue</button><input id="manual" aria-label="Manual input"><button id="pay" type="button" onclick="window.clicks++">Pay</button><script>window.clicks=0</script>',
    );
  },
);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const origin = `https://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({
    executablePath: process.env.ELIZA_BROWSER_EXECUTABLE,
    headless: true,
    acceptInsecureCerts: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(origin);
  const cdp = await page.createCDPSession();
  const frame = async () =>
    (await cdp.send("Page.getFrameTree")).frameTree.frame;
  const realm = async () =>
    (
      await cdp.send("Page.createIsolatedWorld", {
        frameId: (await frame()).id,
        worldName: "task-guidance-host",
      })
    ).executionContextId;
  const evaluate = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", {
      contextId: await realm(),
      expression,
      returnByValue: true,
    });
    assert.equal(r.exceptionDetails, undefined);
    return r.result.value;
  };
  const records = {};
  const api = {
    runtime: { id: "test-extension" },
    storage: {
      local: {
        get: async (key) => ({ [key]: records[key] }),
        set: async (values) => Object.assign(records, values),
      },
    },
    tabs: {
      query: async () => (page.isClosed() ? [] : [{ id: 1 }]),
      get: async () => ({ url: page.url(), status: "complete" }),
    },
    webNavigation: {
      getAllFrames: async () => [
        { frameId: 0, documentId: (await frame()).loaderId },
      ],
    },
    scripting: {
      executeScript: async (request) => {
        assert.deepEqual(request.target.frameIds, [0]);
        assert.equal(request.world, "ISOLATED");
        return [
          {
            frameId: 0,
            documentId: (await frame()).loaderId,
            result: await evaluate(
              `(${request.func.toString()})(...${JSON.stringify(request.args)})`,
            ),
          },
        ];
      },
    },
  };
  let handler = createCommandHandler(api);
  let sequence = 0;
  const send = async (message) => {
    let reply;
    await handler(
      message,
      {
        send: async (value) => {
          reply = value;
        },
      },
      () => true,
    );
    return reply;
  };
  let context = {
    actorId: "actor",
    accountId: "account",
    agentId: "agent",
    taskId: "task",
    epoch: 0,
  };
  const bind = (targets = [], extra = {}) =>
    send({
      type: "task-bind",
      id: `binding-${sequence++}`,
      binding: {
        ...context,
        tabId: "1",
        bindingRevision: context.epoch + 1,
        origin,
        expiresAt: Date.now() + 60000,
        targets,
        revoked: false,
        ...extra,
      },
    });
  const show = async () => {
    const snapshot = await send({
      type: "command",
      id: `read-${sequence++}`,
      command: { subaction: "snapshot", id: "1", taskContext: context },
    });
    assert.equal(snapshot.ok, true);
    const selector = snapshot.result.frames[0].elements.find(
      (e) => e.label === "Continue",
    ).selector;
    const id = `guide-${sequence++}`;
    const reply = await send({
      type: "task-guide",
      id,
      guidance: {
        tabId: "1",
        taskContext: context,
        revision: sequence,
        kind: "show",
        stepId: "continue",
        selector,
        text: "Continue when you are ready.",
        expiresAt: Date.now() + 30000,
      },
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const visibleDeadline = Date.now() + 5000;
    while (!(await evaluate("globalThis.__elizaPageGuidanceV1.visible"))) {
      assert.ok(
        Date.now() < visibleDeadline,
        "Bound guidance did not become visible",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return id;
  };
  const hidden = async () =>
    assert.equal(
      await evaluate("globalThis.__elizaPageGuidanceV1.visible"),
      false,
    );
  assert.equal((await bind()).ok, true);
  const first = await show();
  const output = testOutputPath("task-guidance");
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, "bound-guide.png") });
  await send({ type: "cancel", id: first });
  await hidden();
  await show();
  handler = createCommandHandler(api);
  await handler.recover();
  await hidden();
  context = { ...context, epoch: 1 };
  assert.equal((await bind()).ok, true);
  await show();
  context = { ...context, epoch: 2 };
  assert.equal((await bind()).ok, true);
  await hidden();
  await show();
  await handler.disconnect();
  await hidden();
  assert.equal(await page.evaluate(() => window.clicks), 0);
  const denied = await send({
    type: "command",
    id: "after-disconnect",
    command: { subaction: "snapshot", id: "1", taskContext: context },
  });
  assert.equal(denied.ok, false);
  context = { ...context, epoch: 3 };
  assert.equal((await bind()).ok, true);
  await show();
  await page.goto(`https://localhost:${server.address().port}`);
  const hide = () =>
    send({
      type: "task-guide",
      id: `hide-${sequence++}`,
      guidance: {
        tabId: "1",
        taskContext: context,
        revision: sequence,
        kind: "hide",
      },
    });
  const navigated = await hide();
  assert.equal(navigated.ok, true);
  assert.equal(navigated.result.visible, false);
  assert.deepEqual(records["task-guidance-tabs-v1"], []);
  await page.goto(origin);
  await show();
  assert.equal(await page.evaluate(() => window.clicks), 0);
  // Offers: a trusted tap becomes one value-free answer event for the host.
  context = { ...context, epoch: 4 };
  assert.equal((await bind([], { assistantName: "Grace" })).ok, true);
  const offerRead = await send({
    type: "command",
    id: `offer-read-${sequence++}`,
    command: { subaction: "snapshot", id: "1", taskContext: context },
  });
  const offerTarget = offerRead.result.frames[0].elements.find(
    (e) => e.label === "Manual input",
  ).selector;
  const offerId = `offer-${sequence++}`;
  const offerRevision = sequence;
  const offered = await send({
    type: "task-guide",
    id: offerId,
    guidance: {
      tabId: "1",
      taskContext: context,
      revision: offerRevision,
      kind: "show",
      stepId: "email",
      selector: offerTarget,
      text: "Which email should I use?",
      detail: "Tap one, or type it yourself.",
      tone: "offer",
      answers: [
        {
          id: "card-0",
          kind: "card",
          text: "private.one@example.test",
          tag: "Personal",
        },
        {
          id: "card-1",
          kind: "card",
          text: "private.two@example.test",
          tag: "Work",
        },
        { id: "type", kind: "secondary", text: "I'll type it" },
      ],
      expiresAt: Date.now() + 30000,
    },
  });
  assert.equal(offered.ok, true, JSON.stringify(offered));
  await evaluate(
    "globalThis.chrome={runtime:{sendMessage:async(m)=>{(globalThis.__answers??=[]).push(m);return {delivered:true}}}};true",
  );
  const offerDeadline = Date.now() + 5000;
  while (
    !(await evaluate(
      "globalThis.__elizaPageGuidanceV1.visible && globalThis.__elizaPageGuidanceV1.shadow.querySelector('.label').classList.contains('shown')",
    ))
  ) {
    assert.ok(Date.now() < offerDeadline, "Offer did not become visible");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    await evaluate(
      "globalThis.__elizaPageGuidanceV1.shadow.querySelector('.mark').textContent",
    ),
    "G",
  );
  await new Promise((resolve) => setTimeout(resolve, 850));
  await page.screenshot({ path: join(output, "offer.png") });
  const card = await evaluate(
    "(()=>{const r=globalThis.__elizaPageGuidanceV1.shadow.querySelectorAll('.card')[1].getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()",
  );
  await page.mouse.click(card[0], card[1]);
  const [tapped] = await evaluate("globalThis.__answers");
  const answerSender = async (extra = {}) => ({
    id: "test-extension",
    tab: { id: 1 },
    frameId: 0,
    documentId: (await frame()).loaderId,
    url: page.url(),
    ...extra,
  });
  const answered = (message, sender) => {
    try {
      return handler.answerGuide(message, sender);
    } catch (error) {
      return error;
    }
  };
  for (const [forged, sender] of [
    [{ ...tapped, answerKey: "guessed" }, await answerSender()],
    [{ ...tapped, answerId: "card-9" }, await answerSender()],
    [tapped, await answerSender({ documentId: "other-document" })],
    [tapped, await answerSender({ frameId: 3 })],
    [tapped, await answerSender({ id: "other-extension" })],
    [{ ...tapped, value: "private.two@example.test" }, await answerSender()],
  ])
    assert.equal(answered(forged, sender).kind, "STALE_REF");
  const event = answered(tapped, await answerSender());
  assert.deepEqual(event, {
    type: "task-guide-answer",
    id: offerId,
    tabId: "1",
    stepId: "email",
    revision: offerRevision,
    answerId: "card-1",
  });
  assert.ok(!JSON.stringify(event).includes("example.test"));
  assert.ok(!JSON.stringify(tapped).includes("example.test"));
  assert.equal(answered(tapped, await answerSender()).kind, "STALE_REF");
  assert.ok(
    !(await page.evaluate(() => document.documentElement.outerHTML)).includes(
      "example.test",
    ),
  );
  // Pause keeps only the grey cursor and ends the offer.
  const paused = await send({
    type: "task-guide",
    id: `pause-${sequence++}`,
    guidance: {
      tabId: "1",
      taskContext: context,
      revision: sequence,
      kind: "pause",
    },
  });
  assert.equal(paused.ok, true, JSON.stringify(paused));
  assert.deepEqual(paused.result, { visible: false, paused: true });
  assert.deepEqual(
    await evaluate(
      "(()=>{const s=globalThis.__elizaPageGuidanceV1;return [s.paused,s.shadow.querySelector('.label').hidden,s.shadow.querySelector('.tag').textContent]})()",
    ),
    [true, true, "GGrace · paused"],
  );
  await page.screenshot({ path: join(output, "paused.png") });
  assert.deepEqual(records["task-guidance-tabs-v1"], ["1"]);
  // Actual bound actions own their preview and still revalidate before dispatch.
  context = { ...context, epoch: 5 };
  assert.equal(
    (
      await bind([
        { selector: "#target", action: "click" },
        { selector: "#manual", action: "fill" },
        { selector: "#pay", action: "click" },
      ])
    ).ok,
    true,
  );
  const startAction = async (extra = {}, label = "Continue") => {
    const read = await send({
      type: "command",
      id: `action-read-${sequence++}`,
      command: { subaction: "snapshot", id: "1", taskContext: context },
    });
    assert.equal(read.ok, true);
    const selector = read.result.frames[0].elements.find(
      (e) => e.label === label,
    ).selector;
    const id = `action-${sequence++}`;
    return {
      id,
      pending: send({
        type: "command",
        id,
        command: {
          subaction: "click",
          id: "1",
          selector,
          taskContext: context,
          ...extra,
        },
      }),
    };
  };
  const pointerVisible = () =>
    evaluate(
      'globalThis.__elizaPageGuidanceV1?.visible && globalThis.__elizaPageGuidanceV1?.host.isConnected && globalThis.__elizaPageGuidanceV1?.shadow.querySelector(".pointer")?.style.display === "block"',
    );
  const waitPointer = async () => {
    const deadline = Date.now() + 3000;
    while (!(await pointerVisible())) {
      assert.ok(Date.now() < deadline, "Pointer did not become visible");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const cancelledAction = await startAction();
  await waitPointer();
  await page.screenshot({ path: join(output, "action-preview.png") });
  await send({ type: "cancel", id: cancelledAction.id });
  assert.equal((await cancelledAction.pending).ok, false);
  assert.equal(await pointerVisible(), false);
  assert.equal(await page.evaluate(() => window.clicks), 0);
  const pausedAction = await startAction();
  await waitPointer();
  const pausing = await send({
    type: "task-guide",
    id: `pause-${sequence++}`,
    guidance: {
      tabId: "1",
      taskContext: context,
      revision: sequence,
      kind: "pause",
    },
  });
  assert.equal(pausing.ok, true);
  assert.equal((await pausedAction.pending).ok, false);
  assert.equal(await page.evaluate(() => window.clicks), 0);
  const changedAction = await startAction();
  await waitPointer();
  await page.$eval("#target", (node) => (node.style.marginLeft = "130px"));
  assert.equal((await changedAction.pending).ok, false);
  assert.equal(await page.evaluate(() => window.clicks), 0);
  const dismissedAction = await startAction();
  await waitPointer();
  await evaluate(
    'globalThis.__elizaPageGuidanceV1.shadow.querySelector("button").click()',
  );
  assert.equal((await dismissedAction.pending).ok, false);
  assert.equal(await page.evaluate(() => window.clicks), 0);
  const typingAction = await startAction();
  await waitPointer();
  await page.focus("#manual");
  await page.keyboard.type("manual");
  assert.equal((await typingAction.pending).ok, false);
  assert.equal(await page.evaluate(() => window.clicks), 0);
  const expiredAction = await startAction({ taskExpiresAt: Date.now() + 350 });
  assert.equal((await expiredAction.pending).ok, false);
  assert.equal(await page.evaluate(() => window.clicks), 0);
  const forbiddenAction = await startAction({}, "Pay");
  assert.equal((await forbiddenAction.pending).error.kind, "POLICY_BLOCKED");
  assert.equal(await pointerVisible(), false);
  const execute = api.scripting.executeScript;
  api.scripting.executeScript = async (request) => {
    const result = await execute(request);
    if (
      request.args[0].subaction === "click" &&
      !request.args[2] &&
      result[0].result.dispatched
    ) {
      await page.screenshot({ path: join(output, "action-tap.png") });
    }
    return result;
  };
  const approvedAction = await startAction();
  await waitPointer();
  assert.equal((await approvedAction.pending).ok, true);
  assert.equal(await page.evaluate(() => window.clicks), 1);
  assert.equal(await pointerVisible(), false);
  await page.setViewport({ width: 640, height: 960 });
  const fillAction = await startAction(
    { subaction: "fill", text: "approved fixture value" },
    "Manual input",
  );
  await waitPointer();
  await page.screenshot({ path: join(output, "fill-preview.png") });
  assert.equal((await fillAction.pending).ok, true);
  assert.equal(
    await page.$eval("#manual", (node) => node.value),
    "approved fixture value",
  );
  await page.close();
  const closed = await hide();
  assert.equal(closed.ok, true);
  assert.equal(closed.result.tabClosed, true);
  assert.deepEqual(records["task-guidance-tabs-v1"], []);
  writeFileSync(
    join(output, "verification.json"),
    JSON.stringify(
      {
        browser: await browser.version(),
        cases: [
          "bound target display",
          "cancel removes acknowledged guide",
          "new epoch removes old guide",
          "disconnect removes guide and revokes old binding",
          "worker restart clears persisted guidance before rebinding",
          "cross-origin navigation removal receipt",
          "closed-tab absence receipt",
          "guidance-only phases dispatch zero website actions",
          "cancel, target movement, manual input, deadline and preview dismissal prevent action",
          "Pay policy denial occurs before showing an action pointer",
          "approved fill shows its own instruction and writes the controlled value",
          "approved native action shows pointer before one actual click and tap after dispatch",
          "configured assistant name; offer tap becomes one answer-ID event; forged, repeated and cross-document answers rejected",
          "pause keeps a grey paused cursor, ends the offer and cancels a pending action",
        ],
        scope:
          "actual Chromium + command handler; not installed native transport or Android",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS task-guidance Chromium binding/cancel/rebind/disconnect and guarded action feedback",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
