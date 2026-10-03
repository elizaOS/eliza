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
