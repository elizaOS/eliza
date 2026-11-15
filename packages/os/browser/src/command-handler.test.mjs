import assert from "node:assert/strict";
import test from "node:test";
import { createCommandHandler } from "./command-handler.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const records = {};
  const api = {
    storage: {
      local: {
        get: async (key) => ({ [key]: records[key] }),
        set: async (values) => {
          Object.assign(records, values);
        },
      },
    },
  };
  const replies = [];
  return {
    api,
    records,
    replies,
    sender: {
      send: async (value) => {
        replies.push(value);
      },
    },
  };
}

test("native cancellation bypasses a pending lookup and persists across handler restart", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  let effects = 0;
  f.api.tabs = {
    get: async () => {
      entered.resolve();
      await release.promise;
      return { url: "https://example.test/" };
    },
    update: async () => {
      effects++;
    },
  };
  const handler = createCommandHandler(f.api);
  const request = {
    type: "command",
    id: "request-1",
    command: {
      subaction: "navigate",
      id: "1",
      url: "https://example.test/next",
    },
  };
  const running = handler(request, f.sender, () => true);
  await Promise.race([
    entered.promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Command did not reach the browser API")),
        3000,
      );
      timer.unref();
    }),
  ]);
  await handler({ type: "cancel", id: "request-1" }, f.sender, () => true);
  release.resolve();
  await running;
  assert.equal(effects, 0);
  assert.equal(f.records["request:request-1"], "cancelled");
  assert.equal(f.replies[0].error.kind, "STALE_REF");
  await createCommandHandler(f.api)(request, f.sender, () => true);
  assert.equal(effects, 0);
  assert.equal(f.replies[1].error.kind, "UNCERTAIN_OUTCOME");
});

test("a cancelled queued request never starts after an earlier request completes", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  let queries = 0;
  f.api.tabs = {
    query: async () => {
      queries++;
      entered.resolve();
      await release.promise;
      return [];
    },
  };
  const handler = createCommandHandler(f.api);
  const first = handler(
    { type: "command", id: "first", command: { subaction: "list" } },
    f.sender,
    () => true,
  );
  await Promise.race([
    entered.promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Command did not reach the browser API")),
        3000,
      );
      timer.unref();
    }),
  ]);
  const second = handler(
    { type: "command", id: "second", command: { subaction: "list" } },
    f.sender,
    () => true,
  );
  await handler({ type: "cancel", id: "second" }, f.sender, () => true);
  // The cancelled request had not started, so it is answered at once, not
  // after the request ahead of it: the host then knows nothing of it can
  // still take effect, and a slow request ahead never makes its fence wait.
  assert.deepEqual(
    f.replies.map((reply) => [reply.id, reply.ok]),
    [["second", false]],
  );
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(queries, 1);
  // It is answered once only.
  assert.deepEqual(
    f.replies.map((reply) => [reply.id, reply.ok]),
    [
      ["second", false],
      ["first", true],
    ],
  );
  assert.deepEqual(f.replies[0].error, {
    kind: "STALE_REF",
    message: "The request was cancelled before it took effect.",
    reason: "request-cancelled",
  });
});

test("invalid or stale-port cancellation cannot write a record", async () => {
  const f = fixture();
  const handler = createCommandHandler(f.api);
  await assert.rejects(
    handler(
      { type: "cancel", id: "request", command: {} },
      f.sender,
      () => true,
    ),
    /Invalid cancellation/,
  );
  await handler({ type: "cancel", id: "request" }, f.sender, () => false);
  assert.deepEqual(f.records, {});
});

const binding = {
  bindingRevision: 1,
  tabId: "1",
  actorId: "actor",
  accountId: "account",
  agentId: "agent",
  taskId: "task",
  epoch: 1,
  origin: "https://example.test",
  expiresAt: Date.now() + 600000,
  targets: [{ selector: "#name", action: "fill" }],
  revoked: false,
};
const context = ({ actorId, accountId, agentId, taskId, epoch }) => ({
  actorId,
  accountId,
  agentId,
  taskId,
  epoch,
});

test("bound tabs reject raw, wrong-owner, wrong-origin and non-main-frame commands", async () => {
  const f = fixture();
  let effects = 0;
  f.api.tabs = {
    get: async () => ({ url: binding.origin }),
    update: async () => {
      effects++;
    },
  };
  const handler = createCommandHandler(f.api);
  await handler(
    { type: "task-bind", id: "bind", binding },
    f.sender,
    () => true,
  );
  assert.equal(f.replies.at(-1).ok, true);
  let sequence = 0;
  for (const command of [
    { subaction: "navigate", id: "1", url: binding.origin },
    {
      subaction: "navigate",
      id: "1",
      url: binding.origin,
      taskContext: { ...context(binding), accountId: "other" },
    },
    {
      subaction: "navigate",
      id: "1",
      url: "https://other.test",
      taskContext: context(binding),
    },
    {
      subaction: "click",
      id: "1",
      selector: "12345678-1234-1234-1234-123456789012:1:0",
      taskContext: context(binding),
    },
    { subaction: "reload", id: "1", taskContext: context(binding) },
  ]) {
    await handler(
      { type: "command", id: `denied-${sequence++}`, command },
      f.sender,
      () => true,
    );
    assert.equal(f.replies.at(-1).error.kind, "POLICY_BLOCKED");
  }
  assert.equal(effects, 0);
  await handler(
    {
      type: "command",
      id: "valid",
      command: {
        subaction: "navigate",
        id: "1",
        url: `${binding.origin}/next`,
        taskContext: context(binding),
      },
    },
    f.sender,
    () => true,
  );
  assert.equal(f.replies.at(-1).ok, true);
  assert.equal(effects, 1);
  await createCommandHandler(f.api)(
    {
      type: "command",
      id: "restart",
      command: {
        subaction: "navigate",
        id: "1",
        url: binding.origin,
        taskContext: context(binding),
      },
    },
    f.sender,
    () => true,
  );
  assert.equal(f.replies.at(-1).error.kind, "POLICY_BLOCKED");
  assert.equal(effects, 1);
});

test("binding revocation fences pending lookup and an old epoch cannot restore it", {
  timeout: 3000,
}, async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  let effects = 0;
  f.api.tabs = {
    get: async () => {
      entered.resolve();
      await release.promise;
      return { url: binding.origin };
    },
    update: async () => {
      effects++;
    },
  };
  const handler = createCommandHandler(f.api);
  await handler(
    { type: "task-bind", id: "bind", binding },
    f.sender,
    () => true,
  );
  const running = handler(
    {
      type: "command",
      id: "pending",
      command: {
        subaction: "navigate",
        id: "1",
        url: binding.origin,
        taskContext: context(binding),
      },
    },
    f.sender,
    () => true,
  );
  await entered.promise;
  await handler(
    {
      type: "task-bind",
      id: "revoke",
      binding: { ...binding, epoch: 2, bindingRevision: 2, revoked: true },
    },
    f.sender,
    () => true,
  );
  release.resolve();
  await running;
  assert.equal(effects, 0);
  assert.equal(f.replies.at(-1).error.kind, "POLICY_BLOCKED");
  await handler(
    { type: "task-bind", id: "old", binding },
    f.sender,
    () => true,
  );
  assert.equal(f.replies.at(-1).ok, false);
});

test("protected fill marker requires a bound task context", async () => {
  const f = fixture(),
    handle = createCommandHandler(f.api);
  await handle(
    {
      type: "command",
      id: "protected-unbound",
      command: {
        subaction: "fill",
        id: "1",
        selector: "target",
        text: "123456",
        protectedValueKind: "verification-code",
      },
    },
    f.sender,
    () => true,
  );
  assert.equal(f.replies[0].ok, false);
  assert.equal(f.replies[0].error.kind, "POLICY_BLOCKED");
});

test("native protection account changes bypass work queues and retire on disconnect", async () => {
  const f = fixture();
  const handler = createCommandHandler(f.api);
  let owner = null;
  const delayed = deferred();
  handler.attachProtectionAdvisory({
    setOwner(value) {
      owner = value;
      return value === "old-account"
        ? delayed.promise
        : Promise.resolve({ updated: 0, unavailable: 0 });
    },
  });
  assert.equal(handler.hasProtectionAdvisory(), true);
  const old = handler(
    { type: "protection-owner", id: "old", owner: "old-account" },
    f.sender,
    () => true,
  );
  assert.equal(owner, "old-account");
  await handler(
    { type: "protection-owner", id: "new", owner: "new-account" },
    f.sender,
    () => true,
  );
  delayed.resolve({ updated: 1, unavailable: 0 });
  await old;
  assert.equal(
    f.replies.find((reply) => reply.id === "old").error.kind,
    "STALE_REF",
  );
  assert.equal(owner, "new-account");
  await handler.disconnect();
  assert.equal(owner, null);
  await handler(
    { type: "protection-owner", id: "stale", owner: "old-account" },
    f.sender,
    () => false,
  );
  assert.equal(owner, null);
  await assert.rejects(
    handler(
      {
        type: "protection-owner",
        id: "bad",
        owner: "new-account",
        command: {},
      },
      f.sender,
      () => true,
    ),
    /Invalid protection/,
  );
  assert.equal(owner, null);
  await createCommandHandler(f.api)(
    { type: "protection-owner", id: "disabled", owner: null },
    f.sender,
    () => true,
  );
  assert.equal(f.replies.at(-1).error.kind, "UNSUPPORTED");
});

test("a host-extended binding scopes each command to the page's own task origin", async () => {
  const f = fixture();
  let url = "https://example.test/start";
  const updates = [];
  f.api.tabs = {
    get: async () => ({ url }),
    update: async (_id, change) => {
      updates.push(change.url);
    },
  };
  const handler = createCommandHandler(f.api);
  const extended = {
    ...binding,
    origins: [binding.origin, "https://login.example.org"],
  };
  for (const [index, origins] of [
    [binding.origin],
    ["https://login.example.org", "https://other.example.org"],
    [binding.origin, "http://login.example.org"],
    [binding.origin, binding.origin],
    [binding.origin, "https://login.example.org/path"],
  ].entries()) {
    await handler(
      {
        type: "task-bind",
        id: `bad-${index}`,
        binding: { ...extended, origins },
      },
      f.sender,
      () => true,
    );
    assert.equal(f.replies.at(-1).error.kind, "POLICY_BLOCKED");
  }
  await handler(
    { type: "task-bind", id: "bind", binding: extended },
    f.sender,
    () => true,
  );
  assert.equal(f.replies.at(-1).ok, true);
  const navigate = async (id, target) => {
    await handler(
      {
        type: "command",
        id,
        command: {
          subaction: "navigate",
          id: "1",
          url: target,
          taskContext: context(extended),
        },
      },
      f.sender,
      () => true,
    );
    return f.replies.at(-1);
  };
  assert.equal(
    (await navigate("to-login", "https://login.example.org/")).ok,
    true,
  );
  url = "https://login.example.org/sign-in";
  assert.equal((await navigate("back", "https://example.test/after")).ok, true);
  assert.equal(
    (await navigate("elsewhere", "https://elsewhere.example.net/")).error.kind,
    "POLICY_BLOCKED",
  );
  url = "https://elsewhere.example.net/";
  assert.equal(
    (await navigate("from-outside", "https://example.test/")).error.kind,
    "POLICY_BLOCKED",
  );
  assert.deepEqual(updates, [
    "https://login.example.org/",
    "https://example.test/after",
  ]);
});

test("incomplete snapshot replies carry a stable reason beside the kind", async () => {
  const frame = { frameId: 0, documentId: "doc-a" };
  const cases = [
    ["frame-inventory-incomplete", () => [], () => []],
    [
      "frame-identity-changed",
      () => [frame],
      () => [{ ...frame, documentId: "doc-b", result: { complete: true } }],
    ],
    [
      "frame-read-incomplete",
      () => [frame],
      () => [{ ...frame, result: { complete: false } }],
    ],
  ];
  for (const [index, [reason, inventory, read]] of cases.entries()) {
    const f = fixture();
    f.api.tabs = {
      get: async () => ({ url: "https://example.test/", status: "complete" }),
    };
    f.api.webNavigation = { getAllFrames: async () => inventory() };
    f.api.scripting = { executeScript: async () => read() };
    await createCommandHandler(f.api)(
      {
        type: "command",
        id: `snapshot-${index}`,
        command: { subaction: "snapshot", id: "1" },
      },
      f.sender,
      () => true,
    );
    assert.equal(f.replies[0].error.kind, "INCOMPLETE_SNAPSHOT");
    assert.equal(f.replies[0].error.reason, reason);
  }
  const f = fixture();
  f.api.tabs = { get: async () => ({ url: "chrome://settings/" }) };
  await createCommandHandler(f.api)(
    {
      type: "command",
      id: "internal",
      command: { subaction: "snapshot", id: "1" },
    },
    f.sender,
    () => true,
  );
  assert.equal(f.replies[0].error.kind, "POLICY_BLOCKED");
  assert.equal("reason" in f.replies[0].error, false);
});

test("a submit whose reply was lost is a capture gap only when the journal lacks it", async () => {
  const f = fixture();
  f.api.runtime = { id: "extension" };
  f.api.tabs = {
    get: async () => ({ url: `${binding.origin}/form`, status: "complete" }),
  };
  f.api.webNavigation = {
    getAllFrames: async () => [{ frameId: 0, documentId: "doc" }],
  };
  let unconfirmed = [];
  let refused = [];
  f.api.scripting = {
    executeScript: async ({ func }) => [
      {
        frameId: 0,
        documentId: "doc",
        result:
          func.name === "installManualActivity"
            ? {
                installed: true,
                captureGap: refused.length > 0,
                refused,
                unconfirmed,
              }
            : { complete: true, elements: [], blockers: [] },
      },
    ],
  };
  const handler = createCommandHandler(f.api);
  await handler(
    { type: "task-bind", id: "bind", binding },
    f.sender,
    () => true,
  );
  const recorded = "11111111-1111-4111-8111-111111111111";
  await handler.recordManualActivity(
    {
      type: "task-manual-activity",
      kind: "form-submit",
      eventId: recorded,
      bindingRevision: binding.bindingRevision,
    },
    {
      id: "extension",
      tab: { id: 1 },
      frameId: 0,
      documentId: "doc",
      url: `${binding.origin}/form`,
    },
  );
  const gap = async (id, ids, refusedIds = []) => {
    unconfirmed = ids;
    refused = refusedIds;
    await handler(
      {
        type: "command",
        id,
        command: {
          subaction: "snapshot",
          id: "1",
          taskContext: context(binding),
        },
      },
      f.sender,
      () => true,
    );
    const { captureGap, captureGapEvents } =
      f.replies.at(-1).result.frames[0].manualActivity;
    return { captureGap, captureGapEvents };
  };
  const lost = "22222222-2222-4222-8222-222222222222";
  const denied = "33333333-3333-4333-8333-333333333333";
  assert.deepEqual(await gap("recorded", [recorded]), {
    captureGap: false,
    captureGapEvents: [],
  });
  assert.deepEqual(await gap("lost", [recorded, lost]), {
    captureGap: true,
    captureGapEvents: [lost],
  });
  // Each refused submit is named too, so a second failure in the same
  // document is a new gap; malformed IDs are dropped.
  assert.deepEqual(await gap("refused", [lost], [denied, "x"]), {
    captureGap: true,
    captureGapEvents: [denied, lost],
  });
});

test("a task snapshot reports the network watch and never forwards the page's handoff", async () => {
  const f = fixture();
  f.api.runtime = { id: "extension" };
  f.api.tabs = {
    get: async () => ({ url: `${binding.origin}/form`, status: "complete" }),
    update: async () => {},
  };
  f.api.webNavigation = {
    getAllFrames: async () => [{ frameId: 0, documentId: "doc" }],
  };
  const handoff = { presses: [1], activatedAt: null, consentedUrls: [] };
  f.api.scripting = {
    executeScript: async ({ func }) => [
      {
        frameId: 0,
        documentId: "doc",
        result:
          func.name === "installManualActivity"
            ? { installed: true, refused: [], unconfirmed: [] }
            : {
                complete: true,
                elements: [],
                blockers: [],
                watchHandoff: handoff,
              },
      },
    ],
  };
  const calls = [];
  const effects = {
    arm: () => () => {},
    close: (tabId) => {
      calls.push(["close", tabId]);
      return () => calls.push(["reopen", tabId]);
    },
    read: (...args) => {
      calls.push(["read", ...args]);
      return "request";
    },
  };
  const handler = createCommandHandler(f.api, { effects });
  await handler(
    { type: "task-bind", id: "bind", binding },
    f.sender,
    () => true,
  );
  await handler(
    {
      type: "command",
      id: "snap",
      command: {
        subaction: "snapshot",
        id: "1",
        taskContext: context(binding),
      },
    },
    f.sender,
    () => true,
  );
  const [frame] = f.replies.at(-1).result.frames;
  assert.equal("watchHandoff" in frame, false);
  assert.equal(frame.effectViolation, "request");
  assert.deepEqual(frame.effectWatch, { frames: "all", unseen: ["webrtc"] });
  assert.deepEqual(calls, [["read", 1, "1", handoff]]);
  // The host's own navigation ends the watch: the page did not cause it.
  await handler(
    {
      type: "command",
      id: "go",
      command: {
        subaction: "navigate",
        id: "1",
        url: `${binding.origin}/next`,
        taskContext: context(binding),
      },
    },
    f.sender,
    () => true,
  );
  assert.deepEqual(calls.at(-1), ["close", 1]);
  // A navigation the browser refuses leaves the page, and its watch, as it
  // was: the tab turns out to show a browser page by the time it would run.
  let gets = 0;
  f.api.tabs.get = async () => ({
    url: gets++ === 0 ? `${binding.origin}/form` : "chrome://settings",
    status: "complete",
  });
  await handler(
    {
      type: "command",
      id: "go2",
      command: {
        subaction: "navigate",
        id: "1",
        url: `${binding.origin}/next`,
        taskContext: context(binding),
      },
    },
    f.sender,
    () => true,
  );
  assert.equal(f.replies.at(-1).ok, false);
  assert.deepEqual(calls.slice(-2), [
    ["close", 1],
    ["reopen", 1],
  ]);
});

test("a task effect's result hands the network watch its handoff and is never judged", async () => {
  const f = fixture();
  f.api.runtime = { id: "extension" };
  f.api.tabs = {
    get: async () => ({ url: `${binding.origin}/form`, status: "complete" }),
    update: async () => {},
    query: async () => [{ id: 1, active: true }],
  };
  f.api.webNavigation = {
    getAllFrames: async () => [{ frameId: 0, documentId: "doc" }],
  };
  const handoff = {
    presses: [],
    activatedAt: null,
    consentedUrls: [`${binding.origin}/done`],
    expected: { url: `${binding.origin}/done`, method: "POST", exact: true },
  };
  const previous = { scope: "1", presses: [5], activatedAt: null };
  // Every page script answers as a page that accepted and ran the fill.
  f.api.scripting = {
    executeScript: async () => [
      {
        frameId: 0,
        documentId: "doc",
        result: {
          validated: true,
          visible: false,
          accepted: true,
          ready: true,
          dispatched: true,
          completed: false,
          requiresReadback: true,
          watchHandoff: handoff,
          previousWatchHandoff: previous,
        },
      },
    ],
  };
  const calls = [];
  const effects = {
    arm: (...args) => {
      calls.push(["arm", args[0], args[2]]);
      return () => {};
    },
    close: () => {},
    report: (...args) => calls.push(["report", ...args]),
    read: (...args) => {
      calls.push(["read", ...args]);
      return "request";
    },
  };
  const handler = createCommandHandler(f.api, { effects });
  await handler(
    { type: "task-bind", id: "bind", binding },
    f.sender,
    () => true,
  );
  await handler(
    {
      type: "command",
      id: "fill",
      command: {
        subaction: "fill",
        id: "1",
        selector: "12345678-1234-1234-1234-123456789012:0:3",
        expectedSelector: "#name",
        text: "Ana",
        taskContext: context(binding),
      },
    },
    f.sender,
    () => true,
  );
  const reply = f.replies.at(-1);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal("watchHandoff" in reply.result, false);
  assert.equal("previousWatchHandoff" in reply.result, false);
  assert.equal("effectViolation" in reply.result, false);
  assert.deepEqual(calls, [
    ["arm", 1, "fill"],
    ["report", 1, "1", handoff, previous],
  ]);
});
