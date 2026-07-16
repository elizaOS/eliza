/**
 * Boundary-decoder tests for `eliza.native-composer/v1`: field-level rejection of
 * every operation type, attachment-source validation (including structural
 * rejection of any second-file-store shape), and the mixed-batch stream decode
 * that keeps good ops and collects malformed ones. Pure, deterministic.
 */

import { describe, expect, it } from "vitest";
import { NATIVE_COMPOSER_SCHEMA } from "./contract";
import {
  decodeComposerAttachmentSource,
  decodeComposerOperation,
  decodeComposerOperationStream,
} from "./decode";

describe("decodeComposerOperation — envelope guards", () => {
  it("rejects non-objects", () => {
    for (const raw of [null, undefined, 42, "x", [], true]) {
      const r = decodeComposerOperation(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("not-an-object");
    }
  });

  it("requires a string type", () => {
    const r = decodeComposerOperation({ opId: "a", text: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("type");
  });

  it("requires a non-empty opId (the idempotency key)", () => {
    const r = decodeComposerOperation({ type: "send", opId: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("missing-field");
      expect(r.error.field).toBe("opId");
    }
  });

  it("rejects a non-finite at", () => {
    const r = decodeComposerOperation({
      type: "send",
      opId: "a",
      at: Number.NaN,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("at");
  });

  it("rejects an unknown type", () => {
    const r = decodeComposerOperation({ type: "text.delete", opId: "a" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("unknown-type");
  });
});

describe("decodeComposerOperation — per-type fields", () => {
  it("decodes text.insert / text.set and rejects non-string text", () => {
    expect(
      decodeComposerOperation({ type: "text.insert", opId: "a", text: "hi" })
        .ok,
    ).toBe(true);
    const bad = decodeComposerOperation({
      type: "text.set",
      opId: "a",
      text: 3,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.field).toBe("text");
  });

  it("decodes attachment.add and requires attachmentId + a valid source", () => {
    const ok = decodeComposerOperation({
      type: "attachment.add",
      opId: "a",
      attachmentId: "att1",
      attachment: {
        source: "stored",
        url: `/api/media/${"a".repeat(64)}.png`,
      },
    });
    expect(ok.ok).toBe(true);
    const noId = decodeComposerOperation({
      type: "attachment.add",
      opId: "a",
      attachment: { source: "stored", url: "/api/media/x.png" },
    });
    expect(noId.ok).toBe(false);
    if (!noId.ok) expect(noId.error.field).toBe("attachmentId");
  });

  it("decodes cancel scope and rejects a bad scope", () => {
    expect(
      decodeComposerOperation({ type: "cancel", opId: "a", scope: "draft" }).ok,
    ).toBe(true);
    const bad = decodeComposerOperation({
      type: "cancel",
      opId: "a",
      scope: "everything",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.field).toBe("scope");
  });

  it("decodes focus.set with optional keyboard and rejects a bad keyboard", () => {
    expect(
      decodeComposerOperation({
        type: "focus.set",
        opId: "a",
        focused: true,
        keyboard: "shown",
      }).ok,
    ).toBe(true);
    const bad = decodeComposerOperation({
      type: "focus.set",
      opId: "a",
      focused: true,
      keyboard: "up",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.field).toBe("keyboard");
  });

  it("decodes voice.handoff phase and rejects a bad phase", () => {
    expect(
      decodeComposerOperation({
        type: "voice.handoff",
        opId: "a",
        phase: "commit",
        transcript: "hi",
      }).ok,
    ).toBe(true);
    const bad = decodeComposerOperation({
      type: "voice.handoff",
      opId: "a",
      phase: "pause",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.field).toBe("phase");
  });

  it("decodes reply.set and rejects a reply without messageId", () => {
    expect(
      decodeComposerOperation({
        type: "reply.set",
        opId: "a",
        reply: { messageId: "m1", preview: "hey" },
      }).ok,
    ).toBe(true);
    const bad = decodeComposerOperation({
      type: "reply.set",
      opId: "a",
      reply: { preview: "hey" },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.field).toBe("reply.messageId");
  });

  it("decodes mention.add and rejects a bad mention kind", () => {
    expect(
      decodeComposerOperation({
        type: "mention.add",
        opId: "a",
        mention: { id: "u1", label: "alice", kind: "user" },
      }).ok,
    ).toBe(true);
    const bad = decodeComposerOperation({
      type: "mention.add",
      opId: "a",
      mention: { id: "u1", label: "alice", kind: "bot" },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.field).toBe("mention.kind");
  });

  it("ignores unknown extra keys (forward compat)", () => {
    const r = decodeComposerOperation({
      type: "send",
      opId: "a",
      futureField: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect("futureField" in r.operation).toBe(false);
  });
});

describe("decodeComposerAttachmentSource", () => {
  it("decodes each media-store source", () => {
    expect(
      decodeComposerAttachmentSource({
        source: "inline",
        mimeType: "image/png",
        bytesBase64: "AAAA",
      }).ok,
    ).toBe(true);
    expect(
      decodeComposerAttachmentSource({
        source: "data-url",
        dataUrl: "data:image/png;base64,AAAA",
      }).ok,
    ).toBe(true);
    expect(
      decodeComposerAttachmentSource({
        source: "remote",
        url: "https://x.test/a.png",
      }).ok,
    ).toBe(true);
    expect(
      decodeComposerAttachmentSource({
        source: "stored",
        url: "/api/media/x.png",
      }).ok,
    ).toBe(true);
  });

  it("rejects a second-file-store shape (no file-id source exists)", () => {
    const r = decodeComposerAttachmentSource({
      source: "file-id",
      fileId: "f_123",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("source");
      expect(r.error.message).toContain("unknown attachment source");
    }
  });

  it("rejects inline without bytes and data-url that is not a data URL", () => {
    const noBytes = decodeComposerAttachmentSource({
      source: "inline",
      mimeType: "image/png",
    });
    expect(noBytes.ok).toBe(false);
    if (!noBytes.ok) expect(noBytes.error.field).toBe("bytesBase64");
    const notData = decodeComposerAttachmentSource({
      source: "data-url",
      dataUrl: "https://x.test/a.png",
    });
    expect(notData.ok).toBe(false);
    if (!notData.ok) expect(notData.error.field).toBe("dataUrl");
  });
});

describe("decodeComposerOperationStream", () => {
  it("throws on a bad envelope (schema/shape), not on per-op input", () => {
    expect(() => decodeComposerOperationStream(null)).toThrow(TypeError);
    expect(() =>
      decodeComposerOperationStream({ schema: "wrong", operations: [] }),
    ).toThrow(/unsupported schema/);
    expect(() =>
      decodeComposerOperationStream({
        schema: NATIVE_COMPOSER_SCHEMA,
        operations: {},
      }),
    ).toThrow(/must be an array/);
  });

  it("keeps good ops and collects malformed ones with index + reason", () => {
    const { operations, rejected } = decodeComposerOperationStream({
      schema: NATIVE_COMPOSER_SCHEMA,
      operations: [
        { type: "text.set", opId: "a", text: "hi" },
        { type: "text.set", opId: "b", text: 9 },
        { type: "send", opId: "c" },
        { type: "??", opId: "d" },
      ],
    });
    expect(operations.map((o) => o.opId)).toEqual(["a", "c"]);
    expect(rejected.map((r) => r.index)).toEqual([1, 3]);
    expect(rejected[0].error.field).toBe("text");
    expect(rejected[1].error.code).toBe("unknown-type");
  });
});
