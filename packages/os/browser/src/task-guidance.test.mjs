import assert from "node:assert/strict";
import test from "node:test";
import { createCommandHandler } from "./command-handler.mjs";

const context = {
  actorId: "actor",
  accountId: "account",
  agentId: "agent",
  taskId: "task",
  epoch: 0,
};
const binding = {
  ...context,
  tabId: "1",
  bindingRevision: 1,
  origin: "https://example.test",
  expiresAt: Date.now() + 240000,
  targets: [],
  revoked: false,
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture() {
  const records = {},
    effects = [],
    replies = [];
  const api = {
    storage: {
      local: {
        get: async (key) => ({ [key]: records[key] }),
        set: async (value) => Object.assign(records, value),
      },
    },
    tabs: {
      get: async () => ({ url: "https://example.test/page" }),
      query: async () => [{ id: 1 }],
    },
    scripting: {
      executeScript: async (request) => {
        effects.push(request.args[0]);
        return [
          {
            result:
              request.args[0].kind === "hide"
                ? { visible: false }
                : { accepted: true, visible: false },
          },
        ];
      },
    },
  };
  const handler = createCommandHandler(api),
    sender = { send: async (message) => replies.push(message) };
  const send = async (message) => {
    await handler(message, sender, () => true);
    return replies.at(-1);
  };
  const bind = async (changes) =>
    send({
      type: "task-bind",
      id: "binding",
      binding: { ...binding, ...changes },
    });
  const guide = (revision, kind = "show", changes = {}) => ({
    type: "task-guide",
    id: `guide-${revision}`,
    guidance: {
      tabId: "1",
      taskContext: context,
      revision,
      kind,
      ...(kind === "show"
        ? {
            stepId: "step",
            selector: "00000000-0000-0000-0000-000000000000:0:0",
            text: "Continue here",
            expiresAt: Date.now() + 60000,
          }
        : {}),
      ...changes,
    },
  });
  return { api, records, effects, replies, handler, send, bind, guide };
}
test("guidance requires a live exact task binding and never accepts raw browser guide commands", async () => {
  const f = fixture();
  assert.equal((await f.send(f.guide(1))).ok, false);
  assert.equal(f.effects.length, 0);
  await f.bind();
  assert.equal(
    (
      await f.send(
        f.guide(1, "show", { taskContext: { ...context, accountId: "other" } }),
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await f.send({
        type: "command",
        id: "raw",
        command: { id: "1", subaction: "guide" },
      })
    ).ok,
    false,
  );
  assert.equal((await f.send(f.guide(1))).ok, true);
  assert.equal(f.effects[0].origin, binding.origin);
  assert.equal(f.effects[0].id, "1:step");
  assert.equal((await f.send(f.guide(1))).ok, false);
  assert.equal(f.effects.length, 1);
  await f.send(f.guide(2, "hide"));
  assert.equal(f.effects.at(-1).kind, "hide");
});
test("unacknowledged hide retains recovery metadata until removal succeeds", async () => {
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  const execute = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async () => [{ result: { visible: true } }];
  assert.equal((await f.send(f.guide(2, "hide"))).ok, false);
  assert.deepEqual(f.records["task-guidance-tabs-v1"], ["1"]);
  f.api.scripting.executeScript = execute;
  await f.handler.disconnect();
  assert.deepEqual(f.records["task-guidance-tabs-v1"], []);
});
test("a delayed older show cannot replace an already accepted hide", async () => {
  const f = fixture();
  await f.bind();
  const entered = deferred(),
    release = deferred();
  let reads = 0;
  f.api.tabs.get = async () => {
    if (++reads === 1) {
      entered.resolve();
      await release.promise;
    }
    return { url: "https://example.test/page" };
  };
  const pending = f.send(f.guide(1));
  await entered.promise;
  await f.send(f.guide(2, "hide"));
  release.resolve();
  await pending;
  assert.deepEqual(
    f.effects.map((e) => e.kind),
    ["hide"],
  );
});
test("cancel removes guidance even when page injection was already in flight", async () => {
  const f = fixture();
  await f.bind();
  const entered = deferred(),
    release = deferred();
  const execute = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async (request) => {
    if (request.args[0].kind === "show") {
      entered.resolve();
      await release.promise;
    }
    return execute(request);
  };
  const pending = f.send(f.guide(1));
  await entered.promise;
  const cancelled = f.handler(
    { type: "cancel", id: "guide-1" },
    { send: async () => {} },
    () => true,
  );
  release.resolve();
  await Promise.all([pending, cancelled]);
  assert.equal(f.effects.at(-1).kind, "hide");
  assert.equal(f.replies.at(-1).ok, false);
});
test("rebind and disconnect remove guides and disconnect requires a fresh binding", async () => {
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  await f.bind({ bindingRevision: 2, epoch: 1, revoked: true });
  assert.equal(f.effects.at(-1).kind, "hide");
  assert.equal((await f.send(f.guide(2))).ok, false);
  await f.bind({ bindingRevision: 3, epoch: 2 });
  await f.send(f.guide(1, "show", { taskContext: { ...context, epoch: 2 } }));
  await f.handler.disconnect();
  assert.equal(f.effects.at(-1).kind, "hide");
  assert.equal(
    (
      await f.send(
        f.guide(2, "show", { taskContext: { ...context, epoch: 2 } }),
      )
    ).ok,
    false,
  );
});
test("failed admission persistence removes the prior guide instead of leaving stale UI", async () => {
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  const set = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    if (value["request:guide-2"]) throw new Error("disk unavailable");
    return set(value);
  };
  assert.equal((await f.send(f.guide(2))).ok, false);
  assert.equal(f.effects.at(-1).kind, "hide");
});

test("failed removal remains tracked so a later disconnect retries it", async () => {
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  const execute = f.api.scripting.executeScript;
  let failed = false;
  f.api.scripting.executeScript = async (request) => {
    if (request.args[0].kind === "hide" && !failed) {
      failed = true;
      throw new Error("injection temporarily unavailable");
    }
    return execute(request);
  };
  await assert.rejects(f.handler.disconnect());
  await f.handler.disconnect();
  assert.equal(f.effects.at(-1).kind, "hide");
});

test("a restarted handler removes indexed guides before accepting a fresh binding", async () => {
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  assert.deepEqual(f.records["task-guidance-tabs-v1"], ["1"]);
  f.api.tabs.query = async () => [{ id: 1 }, { id: 2 }];
  const restarted = createCommandHandler(f.api);
  await restarted.recover();
  assert.equal(f.effects.at(-1).kind, "hide");
  assert.deepEqual(f.records["task-guidance-tabs-v1"], []);
  let reply;
  await restarted(
    f.guide(2),
    {
      send: async (value) => {
        reply = value;
      },
    },
    () => true,
  );
  assert.equal(reply.ok, false);
});
test("missing removal receipt retains the recovery index and closed tabs can be retired", async () => {
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  const execute = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async () => [];
  await assert.rejects(f.handler.disconnect(), /not acknowledged/);
  assert.deepEqual(f.records["task-guidance-tabs-v1"], ["1"]);
  f.api.scripting.executeScript = execute;
  f.api.tabs.query = async () => [];
  await createCommandHandler(f.api).recover();
  assert.deepEqual(f.records["task-guidance-tabs-v1"], []);
});

test("a new guide queued behind removal remains in the restart index", async () => {
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  const entered = deferred(),
    release = deferred();
  const execute = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async (request) => {
    if (request.args[0].kind === "hide") {
      entered.resolve();
      await release.promise;
    }
    return execute(request);
  };
  const removing = f.handler(
    { type: "cancel", id: "guide-1" },
    { send: async () => {} },
    () => true,
  );
  await entered.promise;
  const showing = f.send(f.guide(2));
  release.resolve();
  await Promise.all([removing, showing]);
  assert.equal(f.effects.at(-1).kind, "show");
  assert.deepEqual(f.records["task-guidance-tabs-v1"], ["1"]);
});

test("navigation and expiry allow owner-bound removal but never authorize another show", async (t) => {
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  f.api.tabs.get = async () => ({ url: "https://other.example/path" });
  assert.equal((await f.send(f.guide(2))).ok, false);
  assert.equal(
    (
      await f.send(
        f.guide(2, "hide", { taskContext: { ...context, accountId: "other" } }),
      )
    ).ok,
    false,
  );
  t.mock.method(Date, "now", () => binding.expiresAt + 1000);
  const removed = await f.send(f.guide(3, "hide"));
  assert.equal(removed.ok, true);
  assert.equal(removed.result.visible, false);
  assert.deepEqual(f.records["task-guidance-tabs-v1"], []);
  assert.equal((await f.send(f.guide(4))).ok, false);
});

test("closed tabs receive absence receipts and inventory failures retain recovery", async () => {
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  f.api.tabs.query = async () => {
    throw new Error("Inventory unavailable");
  };
  assert.equal((await f.send(f.guide(2, "hide"))).ok, false);
  assert.deepEqual(f.records["task-guidance-tabs-v1"], ["1"]);
  f.api.tabs.query = async () => [];
  const removed = await f.send(f.guide(3, "hide"));
  assert.equal(removed.ok, true);
  assert.equal(removed.result.tabClosed, true);
  assert.deepEqual(f.records["task-guidance-tabs-v1"], []);
  assert.deepEqual(
    f.effects.map((e) => e.kind),
    ["show"],
  );
});

test("closure during removal is confirmed by a second inventory read", async () => {
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  let inventories = 0;
  f.api.tabs.query = async () => (++inventories === 1 ? [{ id: 1 }] : []);
  f.api.scripting.executeScript = async () => {
    throw new Error("Tab closed during injection");
  };
  const removed = await f.send(f.guide(2, "hide"));
  assert.equal(removed.ok, true);
  assert.equal(removed.result.tabClosed, true);
  assert.equal(inventories, 2);
});

test("an old owner cannot remove a newly bound owner's guide", async () => {
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  const next = {
    ...context,
    accountId: "next-account",
    taskId: "next-task",
    epoch: 1,
  };
  await f.bind({ ...next, bindingRevision: 2 });
  await f.send(f.guide(2, "show", { taskContext: next }));
  const effects = f.effects.length;
  assert.equal((await f.send(f.guide(3, "hide"))).ok, false);
  assert.equal(f.effects.length, effects);
  assert.deepEqual(f.records["task-guidance-tabs-v1"], ["1"]);
});

const offer = (changes = {}) => ({
  tone: "offer",
  answers: [
    { id: "card-0", kind: "card", text: "first@example.test", tag: "Home" },
    { id: "card-1", kind: "card", text: "second@example.test", tag: "Work" },
    { id: "type", kind: "secondary", text: "I'll type it" },
  ],
  ...changes,
});
function answering() {
  const f = fixture();
  f.api.runtime = { id: "extension" };
  const execute = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async (request) =>
    (await execute(request)).map((result) => ({
      ...result,
      documentId: "document-1",
    }));
  const sender = {
    id: "extension",
    tab: { id: 1 },
    frameId: 0,
    documentId: "document-1",
    url: "https://example.test/page",
  };
  const tap = (answerId = "card-1") => ({
    type: "task-guide-answer",
    guideId: "1:step",
    answerKey: f.effects.findLast((e) => e.answerKey)?.answerKey,
    answerId,
  });
  return { ...f, sender, tap };
}

test("labels carry detail, tone and validated offer answers to the page", async () => {
  const f = fixture();
  await f.bind({ assistantName: "Grace" });
  let revision = 0;
  for (const invalid of [
    { tone: "offer" },
    { tone: "loud" },
    { detail: "" },
    { detail: "x".repeat(301) },
    { answers: offer().answers },
    offer({ tone: "instruction" }),
    offer({ answers: [offer().answers[0], offer().answers[2]] }),
    offer({
      answers: [0, 1, 2, 3].map((i) => ({
        id: `c${i}`,
        kind: "card",
        text: `v${i}`,
      })),
    }),
    offer({
      answers: [
        ...offer().answers.slice(0, 2),
        { id: "yes", kind: "primary", text: "Yes" },
      ],
    }),
    offer({ answers: [{ id: "a", kind: "primary", text: "Yes", tag: "x" }] }),
    offer({ answers: [{ id: "a", kind: "primary", text: "Yes", value: "x" }] }),
    offer({
      answers: [
        { id: "a", kind: "primary", text: "Yes" },
        { id: "a", kind: "secondary", text: "No" },
      ],
    }),
    offer({ answers: [{ id: "bad id", kind: "primary", text: "Yes" }] }),
  ]) {
    const reply = await f.send(f.guide(++revision, "show", invalid));
    assert.equal(reply.error?.kind, "INVALID_REQUEST", JSON.stringify(invalid));
  }
  assert.equal(f.effects.length, 0);
  assert.equal(
    (await f.send(f.guide(++revision, "pause", { text: "x" }))).ok,
    false,
  );
  const shown = await f.send(
    f.guide(++revision, "show", offer({ detail: "Tap one to fill it in." })),
  );
  assert.equal(shown.ok, true);
  const request = f.effects.at(-1);
  assert.equal(request.detail, "Tap one to fill it in.");
  assert.equal(request.tone, "offer");
  assert.deepEqual(request.answers, offer().answers);
  assert.match(request.answerKey, /^[0-9a-f-]{36}$/);
  assert.equal(request.assistantName, "Grace");
  assert.deepEqual(
    request.fonts.map((font) => font.weight),
    [500, 700],
  );
  assert.equal(
    (
      await f.send(
        f.guide(++revision, "show", {
          tone: "offer",
          answers: [
            { id: "yes", kind: "primary", text: "Yes" },
            { id: "type", kind: "secondary", text: "I'll type it" },
          ],
        }),
      )
    ).ok,
    true,
  );
  assert.equal(
    (await f.send(f.guide(++revision, "show", { tone: "success" }))).ok,
    true,
  );
  assert.equal(f.effects.at(-1).answerKey, undefined);
});

test("the assistant name is optional binding configuration with a bounded display value", async () => {
  for (const assistantName of ["", " ", "x".repeat(33), "Gr\u0000ace", 7]) {
    const f = fixture();
    assert.equal((await f.bind({ assistantName })).ok, false);
  }
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  assert.equal(f.effects.at(-1).assistantName, undefined);
});

test("pause is owner-bound like removal and remains available after expiry", async (t) => {
  const f = fixture();
  await f.bind();
  await f.send(f.guide(1));
  t.mock.method(Date, "now", () => binding.expiresAt + 1000);
  const execute = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async (request) => {
    if (request.args[0].kind !== "pause") return execute(request);
    f.effects.push(request.args[0]);
    return [{ result: { visible: false, paused: true } }];
  };
  const paused = await f.send(f.guide(2, "pause"));
  assert.equal(paused.ok, true);
  assert.deepEqual(f.effects.at(-1), { kind: "pause" });
  assert.deepEqual(f.records["task-guidance-tabs-v1"], ["1"]);
  assert.equal(
    (
      await f.send(
        f.guide(3, "pause", {
          taskContext: { ...context, accountId: "other" },
        }),
      )
    ).ok,
    false,
  );
  assert.equal((await f.send(f.guide(4))).ok, false);
});

test("an offer answer is consumed once and only for its current show", async () => {
  const f = answering();
  await f.bind();
  await f.send(f.guide(1, "show", offer()));
  const event = f.handler.answerGuide(f.tap(), f.sender);
  assert.deepEqual(event, {
    type: "task-guide-answer",
    id: "guide-1",
    tabId: "1",
    stepId: "step",
    revision: 1,
    answerId: "card-1",
  });
  assert.ok(!JSON.stringify(event).includes("example.test"));
  assert.throws(() => f.handler.answerGuide(f.tap(), f.sender), /observe/);
  await f.send(f.guide(2, "show", offer()));
  for (const [message, sender] of [
    [{ ...f.tap(), answerKey: "guess" }, f.sender],
    [{ ...f.tap(), guideId: "2:other" }, f.sender],
    [f.tap("missing"), f.sender],
    [{ ...f.tap(), text: "second@example.test" }, f.sender],
    [f.tap(), { ...f.sender, documentId: "document-2" }],
    [f.tap(), { ...f.sender, frameId: 1 }],
    [f.tap(), { ...f.sender, id: "other-extension" }],
    [f.tap(), { ...f.sender, url: "https://other.example/page" }],
    [f.tap(), { ...f.sender, tab: { id: 2 } }],
  ])
    assert.throws(() => f.handler.answerGuide(message, sender), /observe/);
  const key = f.tap();
  await f.send(f.guide(3, "show"));
  assert.throws(() => f.handler.answerGuide(key, f.sender), /observe/);
  await f.send(f.guide(4, "show", offer()));
  const pending = f.tap();
  await f.handler(
    { type: "cancel", id: "guide-4" },
    { send: async () => {} },
    () => true,
  );
  assert.throws(() => f.handler.answerGuide(pending, f.sender), /observe/);
  await f.send(f.guide(5, "show", offer()));
  const revoked = f.tap();
  await f.handler.disconnect();
  assert.throws(() => f.handler.answerGuide(revoked, f.sender), /observe/);
});

test("an offer whose page document is unknown accepts no answer", async () => {
  const f = answering();
  f.api.scripting.executeScript = async (request) => {
    f.effects.push(request.args[0]);
    return [{ result: { accepted: true, visible: false } }];
  };
  await f.bind();
  await f.send(f.guide(1, "show", offer()));
  assert.throws(() => f.handler.answerGuide(f.tap(), f.sender), /observe/);
});
