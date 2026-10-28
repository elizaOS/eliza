// Portable owning regression; Node >=24. No package install, runtime or models.
// From SDK root: node --test plugins/plugin-assistant/src/services/message/navigation-diagnostic.test.mjs
// Every production input resolves relative to this file, independent of cwd.
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function diagnosticHook(source, phase) {
  const file = ts.createSourceFile(
    "hook.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let result;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "emitNavigationDiagnostic" &&
      node.arguments[2]?.getText(file) === JSON.stringify(phase) &&
      node.getText(file).includes("errorCode:")
    )
      result = node.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

const file = new URL("./navigation-diagnostic.ts", import.meta.url);
const code = stripTypeScriptTypes(
  fs.readFileSync(file, "utf8").replace(/^import type .*;\n/gm, ""),
  { mode: "transform" },
).replace(/^export /gm, "");
function fixture() {
  const events = [];
  let now = 1000000;
  const scope = {
    agentId: "agent",
    roomId: "room",
    entityId: "owner",
    messageId: "message",
    expiresAt: now + 300000,
  };
  let setting = JSON.stringify(scope);
  const runtime = {
    agentId: "agent",
    getSetting: () => setting,
    logger: { info: (data) => events.push(JSON.parse(data.projection)) },
  };
  const message = {
    id: "message",
    agentId: "agent",
    roomId: "room",
    entityId: "owner",
    content: { source: "client_chat" },
  };
  const context = {
    Date: { now: () => now },
    TextEncoder,
    JSON,
    Set,
    WeakMap,
    Object,
    Number,
  };
  vm.runInNewContext(
    code +
      ";globalThis.emit=emitNavigationDiagnostic;globalThis.project=navigationDiagnosticProjection;",
    context,
  );
  return {
    events,
    runtime,
    message,
    scope,
    emit: (phase, input) => context.emit(runtime, message, phase, () => input),
    project: context.project,
    lazy: (phase, input) => context.emit(runtime, message, phase, input),
    set: (v) => (setting = v),
    advance: (ms) => (now += ms),
  };
}
test("default off, exact actor/room/message/source only and malformed scopes never capture", () => {
  const f = fixture();
  for (const raw of [
    null,
    "",
    "{}",
    JSON.stringify({ ...f.scope, unexpected: true }),
    JSON.stringify({ ...f.scope, expiresAt: 1300001 }),
  ]) {
    f.set(raw);
    assert.equal(f.emit("stage1", {}), false);
  }
  for (const [key, value] of [
    ["id", "other"],
    ["agentId", "other"],
    ["entityId", "other"],
    ["roomId", "other"],
  ]) {
    f.set(JSON.stringify(f.scope));
    const before = f.message[key];
    f.message[key] = value;
    assert.equal(f.emit("stage1", {}), false);
    f.message[key] = before;
  }
  f.message.content.source = "background_memory";
  assert.equal(f.emit("stage1", {}), false);
  assert.equal(f.events.length, 0);
});
test("only explicit operational keys reach normal logs; hidden reasoning, secrets and tool bodies stay excluded", () => {
  const f = fixture();
  const forbidden = "DO_NOT_LOG_SECRET";
  const input = {
    visualContinuation: {
      disposition: "direct",
      viewId: "notes",
      reason: forbidden,
    },
    intents: ["Open Notes"],
    replyEffectStatus: "pending",
    replyText: "Opening Notes.",
    reasoning: forbidden,
    thought: forbidden,
    systemPrompt: forbidden,
    toolResult: { body: forbidden },
    credentials: forbidden,
    usage: {
      inputTokens: 12,
      outputTokens: 4,
      latencyMs: 100,
      reasoningTokens: 999,
    },
  };
  assert.equal(f.emit("stage1", input), true);
  const text = JSON.stringify(f.events);
  assert.equal(text.includes(forbidden), false);
  assert.equal(text.includes("reasoningTokens"), false);
  assert.equal(f.events[0].replyText, "Opening Notes.");
  assert.equal(f.events[0].usage.inputTokens, 12);
});
test("lifetime, five unique phases, per-event/total byte caps and nonrenewal are enforced without timers", () => {
  const f = fixture();
  assert.equal(
    f.emit("stage1", {
      replyText: "x".repeat(513),
      intents: ["x".repeat(513)],
    }),
    true,
  );
  assert.equal(f.events[0].replyText, undefined);
  assert.equal(f.emit("stage1", {}), false);
  for (const phase of ["prepared", "egress", "recovery", "failure"])
    assert.equal(
      f.emit(phase, { errorCode: "raw provider error with secret" }),
      true,
    );
  assert.equal(f.events.length, 5);
  assert.equal(f.events[4].errorFamily, "OTHER");
  assert.ok(Buffer.byteLength(JSON.stringify(f.events)) < 16384);
  f.set(JSON.stringify({ ...f.scope, messageId: "new" }));
  f.message.id = "new";
  assert.equal(f.emit("stage1", {}), false);
  const g = fixture();
  g.advance(300001);
  assert.equal(g.emit("stage1", {}), false);
  assert.equal(g.events.length, 0);
});
test("throwing diagnostics cannot fail the turn, replay a phase or inspect arbitrary error text", () => {
  const f = fixture();
  f.runtime.logger.info = () => {
    throw Error("sink failure");
  };
  assert.equal(
    f.emit("failure", {
      errorCode: "AUTH",
      get error() {
        throw Error("Forbidden getter");
      },
    }),
    false,
  );
  assert.equal(f.emit("failure", {}), false);
  assert.equal(f.emit("unknown-phase", {}), false);
});

test("all actual owning egress union kinds survive the finite projection", () => {
  const source = fs.readFileSync(
    new URL("./egress-policy.ts", import.meta.url),
    "utf8",
  );
  const union = /export type PlannedReplyClaimKind\s*=([\s\S]*?);/.exec(source);
  assert.ok(union);
  const kinds = [...union[1].matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
  assert.equal(kinds.length, 6);
  const f = fixture();
  for (const validation of kinds) {
    assert.equal(
      f.project("egress", { verdict: "reject", validation }).validation,
      validation,
    );
    assert.equal(
      f.project("recovery", { verdict: "reject", validation }).validation,
      validation,
    );
  }
  assert.equal(
    f.project("egress", { validation: "unknown_secret" }).validation,
    undefined,
  );
});
test("defaultoff and unrelated scopes never evaluate diagnostic getters or handoff work", () => {
  for (const setting of [
    null,
    JSON.stringify({
      agentId: "agent",
      roomId: "other",
      entityId: "owner",
      messageId: "message",
      expiresAt: 1300000,
    }),
  ]) {
    const f = fixture();
    f.set(setting);
    let reads = 0;
    assert.equal(
      f.lazy("prepared", () => {
        reads++;
        throw Error("Handoff parser must not run");
      }),
      false,
    );
    assert.equal(reads, 0);
  }
});
test("throwing error.code getter in the exact production lazy failure hook preserves original thrown identity", () => {
  const source = fs.readFileSync(
    new URL("./pipeline.ts", import.meta.url),
    "utf8",
  );
  const hook = diagnosticHook(source, "failure");
  assert.ok(hook);
  for (const enabled of [false, true]) {
    const f = fixture();
    if (!enabled) f.set(null);
    let reads = 0;
    const original = {
      get code() {
        reads++;
        throw Error("getter");
      },
    };
    let observed;
    const run = new Function(
      "emitNavigationDiagnostic",
      "args",
      "err",
      hook + ";throw err;",
    );
    try {
      run(
        (runtime, message, phase, input) => f.lazy(phase, input),
        { runtime: f.runtime, message: f.message },
        original,
      );
    } catch (error) {
      observed = error;
    }
    assert.equal(observed, original);
    assert.equal(reads, enabled ? 1 : 0);
    assert.equal(f.events.length, 0);
  }
});

test("exact production recovery hook guards a throwing error.code getter and returns to original reporting", () => {
  const source = fs.readFileSync(
    new URL("./egress-policy.ts", import.meta.url),
    "utf8",
  );
  const hook = diagnosticHook(source, "recovery");
  assert.ok(hook);
  for (const enabled of [false, true]) {
    const f = fixture();
    if (!enabled) f.set(null);
    let reads = 0;
    const original = {
      get code() {
        reads++;
        throw Error("getter");
      },
    };
    const run = new Function(
      "emitNavigationDiagnostic",
      "args",
      "error",
      hook + ";return error;",
    );
    assert.equal(
      run(
        (runtime, message, phase, input) => f.lazy(phase, input),
        { runtime: f.runtime, message: f.message },
        original,
      ),
      original,
    );
    assert.equal(reads, enabled ? 1 : 0);
    assert.equal(f.events.length, 0);
  }
});
test("the reviewed eager-error expression demonstrates the original failure-replacement hazard", () => {
  const original = {
    get code() {
      throw Error("diagnostic getter replaced original");
    },
  };
  let observed;
  try {
    try {
      throw original;
    } catch (err) {
      ((runtime, message, phase, input) => false)({}, {}, "failure", {
        errorCode:
          err && typeof err === "object" && "code" in err
            ? err.code
            : undefined,
      });
      throw err;
    }
  } catch (error) {
    observed = error;
  }
  assert.notEqual(observed, original);
  assert.equal(observed.message, "diagnostic getter replaced original");
});

function nextFixture() {
  const f = fixture();
  const scope = {
    mode: "next-client-chat",
    agentId: "agent",
    roomId: "room",
    entityId: "owner",
    notBefore: 1000000,
    expiresAt: 1300000,
  };
  f.set(JSON.stringify(scope));
  f.message.createdAt = 1000000;
  return { ...f, nextScope: scope };
}
test("next mode binds only the first fresh live stage1 message and keeps its actual ID for every later phase", () => {
  const f = nextFixture();
  let reads = 0;
  assert.equal(
    f.lazy("prepared", () => {
      reads++;
      return {};
    }),
    false,
  );
  assert.equal(reads, 0);
  f.message.id = "first";
  assert.equal(f.emit("stage1", { replyText: "Opening Notes." }), true);
  f.message.id = "second";
  assert.equal(
    f.lazy("stage1", () => {
      reads++;
      return {};
    }),
    false,
  );
  assert.equal(reads, 0);
  f.message.id = "first";
  assert.equal(f.emit("prepared", { status: "prepared" }), true);
  assert.equal(f.emit("egress", { verdict: "allow" }), true);
  assert.equal(f.emit("recovery", { verdict: "allow" }), true);
  assert.equal(f.emit("failure", { errorCode: "OTHER" }), true);
  assert.deepEqual(
    f.events.map((e) => e.messageId),
    Array(5).fill("first"),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(f.events)) < 16384);
  assert.equal(f.emit("stage1", {}), false);
});
test("next mode rejects old or replayed messages and invalid host age without evaluating caller inputs", () => {
  for (const mutate of [
    (f) => (f.message.createdAt = 999999),
    (f) => (f.message.createdAt = 1000001),
    (f) => delete f.message.createdAt,
    (f) => (f.message.createdAt = "1000000"),
    (f) => (f.message.content.chatIdempotency = { outcomeJson: "settled" }),
    (f) =>
      (f.message.content.chatIdempotency = { replyRecoveryJson: "retained" }),
    (f) => (f.message.content.source = "background_memory"),
    (f) => (f.message.roomId = "foreign"),
    (f) => (f.message.entityId = "foreign"),
  ]) {
    const f = nextFixture();
    mutate(f);
    let reads = 0;
    assert.equal(
      f.lazy("stage1", () => {
        reads++;
        throw Error("must not evaluate");
      }),
      false,
    );
    assert.equal(reads, 0);
    assert.equal(f.events.length, 0);
  }
});
test("next mode validates strict fresh lease schema, refuses renewal/rotation and keeps exact mode unchanged", () => {
  for (const patch of [
    { notBefore: 1000001 },
    { notBefore: 999999 },
    { expiresAt: 1300001 },
    { mode: "other" },
    { messageId: "forged" },
    { extra: "forged" },
  ]) {
    const f = nextFixture();
    f.set(JSON.stringify({ ...f.nextScope, ...patch }));
    assert.equal(f.emit("stage1", {}), false);
  }
  const f = nextFixture();
  assert.equal(f.emit("stage1", {}), true);
  f.advance(100);
  f.set(
    JSON.stringify({ ...f.nextScope, notBefore: 1000100, expiresAt: 1300100 }),
  );
  assert.equal(f.emit("prepared", {}), false);
  const g = nextFixture();
  g.advance(300001);
  assert.equal(g.emit("stage1", {}), false);
  const exact = fixture();
  assert.equal(exact.emit("failure", { errorCode: "AUTH" }), true);
  assert.equal(exact.events[0].messageId, "message");
});
test("concurrent first-stage admissions bind one message synchronously and exclude unrelated or oversized payloads", async () => {
  const f = nextFixture();
  const results = await Promise.all(
    ["one", "two"].map(async (messageId) => {
      f.message.id = messageId;
      return f.emit("stage1", {
        replyText: "Opening Notes.",
        reasoning: "NO_CAPTURE",
      });
    }),
  );
  assert.deepEqual(results, [true, false]);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].messageId, "one");
  assert.equal(JSON.stringify(f.events).includes("NO_CAPTURE"), false);
});
