/**
 * State-machine tests for the composer reducer — the behavioral spec. Drives the
 * whole acceptance case matrix deterministically: text/mention/reply edits and
 * their oversized rejections, attachment add/remove with permission + cap
 * enforcement, send happy/empty/in-flight/offline-deferred + flush replay,
 * cancellation (send vs draft), duplicate-callback idempotency, draft-revision
 * preservation, and send resolution (success clears, failure keeps).
 */

import { describe, expect, it } from "vitest";
import type { ComposerOperation } from "./contract";
import {
  applyComposerOperation,
  type ComposerApplyContext,
  DEFAULT_COMPOSER_LIMITS,
  defaultApplyContext,
  flushDeferredOperations,
  initialComposerState,
  resolveSend,
} from "./reduce";

const ctx = defaultApplyContext(true);
const offline = defaultApplyContext(false);

/** Fold a sequence of ops from the initial state, returning the final state. */
function run(ops: ComposerOperation[], context: ComposerApplyContext = ctx) {
  let state = initialComposerState();
  const results = ops.map((op) => {
    const step = applyComposerOperation(state, op, context);
    state = step.state;
    return step.result;
  });
  return { state, results };
}

describe("text + mentions + reply", () => {
  it("text.insert appends, text.set replaces, each bumps revision", () => {
    const { state } = run([
      { type: "text.insert", opId: "1", text: "hello " },
      { type: "text.insert", opId: "2", text: "world" },
    ]);
    expect(state.draft.text).toBe("hello world");
    expect(state.draft.revision).toBe(2);
    const { state: s2 } = run([{ type: "text.set", opId: "1", text: "reset" }]);
    expect(s2.draft.text).toBe("reset");
  });

  it("mention.add inserts a token and records the mention", () => {
    const { state } = run([
      {
        type: "mention.add",
        opId: "1",
        mention: { id: "u1", label: "alice", kind: "user" },
      },
    ]);
    expect(state.draft.text).toBe("@alice ");
    expect(state.draft.mentions).toHaveLength(1);
  });

  it("reply.set then reply.clear round-trips", () => {
    const { state } = run([
      {
        type: "reply.set",
        opId: "1",
        reply: { messageId: "m1", preview: "hi" },
      },
      { type: "reply.clear", opId: "2" },
    ]);
    expect(state.draft.reply).toBeNull();
  });

  it("rejects oversized text without mutating the draft", () => {
    const small: ComposerApplyContext = {
      ...ctx,
      limits: { ...DEFAULT_COMPOSER_LIMITS, maxTextLength: 4 },
    };
    const { state, results } = run(
      [{ type: "text.set", opId: "1", text: "toolong" }],
      small,
    );
    expect(results[0].status).toBe("rejected");
    if (results[0].status === "rejected")
      expect(results[0].reason).toBe("oversized");
    expect(state.draft.text).toBe("");
    expect(state.draft.revision).toBe(0);
  });
});

describe("attachments", () => {
  const stored: ComposerOperation = {
    type: "attachment.add",
    opId: "a1",
    attachmentId: "att1",
    attachment: { source: "stored", url: `/api/media/${"a".repeat(64)}.png` },
  };

  it("adds and removes an attachment", () => {
    const { state } = run([
      stored,
      { type: "attachment.remove", opId: "a2", attachmentId: "att1" },
    ]);
    expect(state.draft.attachments).toHaveLength(0);
  });

  it("permission-denied when attach capability is absent", () => {
    const noAttach: ComposerApplyContext = {
      ...ctx,
      capabilities: { attach: false, voice: true },
    };
    const { results } = run([stored], noAttach);
    expect(results[0].status).toBe("rejected");
    if (results[0].status === "rejected")
      expect(results[0].reason).toBe("permission-denied");
  });

  it("oversized when over the attachment count cap", () => {
    const capped: ComposerApplyContext = {
      ...ctx,
      limits: { ...DEFAULT_COMPOSER_LIMITS, maxAttachments: 1 },
    };
    const { results } = run(
      [
        stored,
        {
          type: "attachment.add",
          opId: "a2",
          attachmentId: "att2",
          attachment: {
            source: "stored",
            url: `/api/media/${"b".repeat(64)}.png`,
          },
        },
      ],
      capped,
    );
    expect(results[1].status).toBe("rejected");
    if (results[1].status === "rejected")
      expect(results[1].reason).toBe("oversized");
  });

  it("rejects a malformed attachment source with invalid-input", () => {
    const { results } = run([
      {
        type: "attachment.add",
        opId: "a1",
        attachmentId: "att1",
        attachment: { source: "inline", mimeType: "bad", bytesBase64: "AAAA" },
      },
    ]);
    expect(results[0].status).toBe("rejected");
    if (results[0].status === "rejected")
      expect(results[0].reason).toBe("invalid-input");
  });
});

describe("idempotency — duplicate native callbacks", () => {
  it("a repeated opId is a no-op reported as duplicate", () => {
    let state = initialComposerState();
    const op: ComposerOperation = {
      type: "text.insert",
      opId: "dup",
      text: "x",
    };
    const first = applyComposerOperation(state, op, ctx);
    state = first.state;
    const second = applyComposerOperation(state, op, ctx);
    expect(first.result.status).toBe("applied");
    expect(second.result.status).toBe("duplicate");
    expect(state.draft.text).toBe("x"); // not "xx"
    expect(state.draft.revision).toBe(1);
  });

  it("distinct ops with same content but different opId both apply", () => {
    const { state } = run([
      { type: "text.insert", opId: "1", text: "x" },
      { type: "text.insert", opId: "2", text: "x" },
    ]);
    expect(state.draft.text).toBe("xx");
  });
});

describe("send", () => {
  const seed: ComposerOperation = { type: "text.set", opId: "t", text: "hi" };

  it("rejects an empty send", () => {
    const { results } = run([{ type: "send", opId: "s" }]);
    expect(results[0].status).toBe("rejected");
    if (results[0].status === "rejected")
      expect(results[0].reason).toBe("empty-send");
  });

  it("accepts a send and marks it in flight", () => {
    const { state, results } = run([seed, { type: "send", opId: "s" }]);
    expect(results[1].status).toBe("applied");
    expect(state.sending?.opId).toBe("s");
  });

  it("rejects a second send while one is in flight (concurrency)", () => {
    const { results } = run([
      seed,
      { type: "send", opId: "s1" },
      { type: "send", opId: "s2" },
    ]);
    expect(results[2].status).toBe("rejected");
    if (results[2].status === "rejected")
      expect(results[2].reason).toBe("send-in-flight");
  });

  it("defers a send while offline, then replays it on reconnect", () => {
    const { state } = run([seed, { type: "send", opId: "s" }], offline);
    expect(state.deferred).toHaveLength(1);
    expect(state.sending).toBeNull();
    const flushed = flushDeferredOperations(state, ctx);
    expect(flushed.results[0].status).toBe("applied");
    expect(flushed.state.sending?.opId).toBe("s");
    expect(flushed.state.deferred).toHaveLength(0);
  });

  it("resolveSend success clears the draft; failure keeps it", () => {
    const { state } = run([seed, { type: "send", opId: "s" }]);
    const ok = resolveSend(state, "s", { ok: true, messageId: "m1" });
    expect(ok.draft.text).toBe("");
    expect(ok.sending).toBeNull();

    const { state: state2 } = run([seed, { type: "send", opId: "s" }]);
    const fail = resolveSend(state2, "s", {
      ok: false,
      reason: "invalid-input",
      message: "x",
    });
    expect(fail.draft.text).toBe("hi");
    expect(fail.sending).toBeNull();
  });
});

describe("cancellation", () => {
  it("cancel scope=send aborts the in-flight send, keeps the draft", () => {
    const { state } = run([
      { type: "text.set", opId: "t", text: "hi" },
      { type: "send", opId: "s" },
      { type: "cancel", opId: "c", scope: "send" },
    ]);
    expect(state.sending).toBeNull();
    expect(state.draft.text).toBe("hi");
  });

  it("cancel scope=draft clears the body but keeps focus", () => {
    const { state } = run([
      { type: "focus.set", opId: "f", focused: true, keyboard: "shown" },
      { type: "text.set", opId: "t", text: "hi" },
      { type: "cancel", opId: "c", scope: "draft" },
    ]);
    expect(state.draft.text).toBe("");
    expect(state.draft.focused).toBe(true);
    expect(state.draft.keyboard).toBe("shown");
  });
});

describe("voice handoff + focus", () => {
  it("commit appends the transcript; permission-denied without voice capability", () => {
    const { state } = run([
      { type: "voice.handoff", opId: "v1", phase: "start" },
      {
        type: "voice.handoff",
        opId: "v2",
        phase: "commit",
        transcript: "spoken words",
      },
    ]);
    expect(state.draft.text).toBe("spoken words");

    const noVoice: ComposerApplyContext = {
      ...ctx,
      capabilities: { attach: true, voice: false },
    };
    const { results } = run(
      [{ type: "voice.handoff", opId: "v1", phase: "start" }],
      noVoice,
    );
    expect(results[0].status).toBe("rejected");
    if (results[0].status === "rejected")
      expect(results[0].reason).toBe("permission-denied");
  });

  it("focus.set updates focus + keyboard", () => {
    const { state } = run([{ type: "focus.set", opId: "f", focused: true }]);
    expect(state.draft.focused).toBe(true);
    expect(state.draft.keyboard).toBe("shown");
  });
});
