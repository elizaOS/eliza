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
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(queries, 1);
  assert.deepEqual(
    f.replies.map((reply) => reply.id),
    ["first"],
  );
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
