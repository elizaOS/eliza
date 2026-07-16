/**
 * Client-boundary tests: malformed native input degrades to a typed rejection
 * (never a throw), events are emitted toward the shell, and serialize/hydrate
 * preserves the draft + idempotency ledger + offline queue across a reload — so a
 * duplicate op still no-ops and a deferred send still replays after reconnect.
 */

import { describe, expect, it } from "vitest";
import { createComposerBridgeClient } from "./client";
import type { ComposerEvent } from "./contract";
import { NATIVE_COMPOSER_SCHEMA } from "./contract";

describe("createComposerBridgeClient — boundary + events", () => {
  it("degrades malformed raw input to invalid-input, never throws", () => {
    const client = createComposerBridgeClient();
    const r = client.dispatchRaw({ type: "text.set", opId: "a", text: 9 });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.reason).toBe("invalid-input");
      expect(r.opId).toBe("a");
    }
  });

  it("emits draft.changed + focus.changed for a focus op", () => {
    const client = createComposerBridgeClient();
    const events: ComposerEvent[] = [];
    client.subscribe((e) => events.push(e));
    client.dispatchRaw({
      type: "focus.set",
      opId: "f",
      focused: true,
      keyboard: "shown",
    });
    expect(events.map((e) => e.type)).toEqual([
      "draft.changed",
      "focus.changed",
    ]);
  });

  it("emits voice.state for a voice op and send.result on completion", () => {
    const client = createComposerBridgeClient();
    const events: ComposerEvent[] = [];
    client.subscribe((e) => events.push(e));
    client.dispatchRaw({ type: "text.set", opId: "t", text: "hi" });
    client.dispatchRaw({ type: "voice.handoff", opId: "v", phase: "start" });
    client.dispatchRaw({ type: "send", opId: "s" });
    client.completeSend("s", { ok: true, messageId: "m1" });
    expect(events.some((e) => e.type === "voice.state")).toBe(true);
    const sendResult = events.find((e) => e.type === "send.result");
    expect(sendResult).toBeDefined();
    if (sendResult && sendResult.type === "send.result")
      expect(sendResult.outcome.ok).toBe(true);
    expect(client.getDraft().text).toBe(""); // cleared on successful send
  });
});

describe("createComposerBridgeClient — reload durability", () => {
  it("preserves idempotency across a serialize/hydrate reload", () => {
    const before = createComposerBridgeClient();
    before.dispatchRaw({ type: "text.insert", opId: "dup", text: "x" });
    const snapshot = before.serialize();
    expect(snapshot.schema).toBe(NATIVE_COMPOSER_SCHEMA);

    // Simulate a window reload: new client hydrated from the snapshot.
    const after = createComposerBridgeClient({ snapshot });
    expect(after.getDraft().text).toBe("x");
    const replay = after.dispatchRaw({
      type: "text.insert",
      opId: "dup",
      text: "x",
    });
    expect(replay.status).toBe("duplicate");
    expect(after.getDraft().text).toBe("x"); // not doubled
  });

  it("preserves a deferred offline send across reload, then replays on reconnect", () => {
    const before = createComposerBridgeClient({ online: false });
    before.dispatchRaw({ type: "text.set", opId: "t", text: "hi" });
    before.dispatchRaw({ type: "send", opId: "s" });
    const snapshot = before.serialize();
    expect(snapshot.deferred).toHaveLength(1);

    const after = createComposerBridgeClient({ online: false, snapshot });
    after.setOnline(true);
    expect(after.getState().sending?.opId).toBe("s");
    expect(after.getState().deferred).toHaveLength(0);
  });
});

describe("createComposerBridgeClient — batch replay", () => {
  it("applies a stream envelope in order and surfaces malformed ops in place", () => {
    const client = createComposerBridgeClient();
    const results = client.dispatchRawStream({
      schema: NATIVE_COMPOSER_SCHEMA,
      operations: [
        { type: "text.insert", opId: "1", text: "a" },
        { type: "text.insert", opId: "bad", text: 5 },
        { type: "text.insert", opId: "2", text: "b" },
      ],
    });
    expect(results.map((r) => r.status)).toEqual([
      "applied",
      "rejected",
      "applied",
    ]);
    expect(client.getDraft().text).toBe("ab");
  });

  it("de-dupes a replayed batch after reconnect", () => {
    const client = createComposerBridgeClient();
    const batch = {
      schema: NATIVE_COMPOSER_SCHEMA,
      operations: [{ type: "text.insert", opId: "1", text: "a" }],
    };
    client.dispatchRawStream(batch);
    const second = client.dispatchRawStream(batch);
    expect(second[0].status).toBe("duplicate");
    expect(client.getDraft().text).toBe("a");
  });
});
