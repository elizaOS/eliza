/**
 * Boundary-decoder unit tests: per-type field validation for typed intents, the
 * real native deep-link shapes (App Intents / Android shortcuts) mapped to typed
 * intents, unknown-source and unrecognized-launch rejections, and the legacy
 * assistant-launch-payload adapter. Deterministic; no I/O.
 */
import { describe, expect, it } from "vitest";
import type { AssistantLaunchPayload } from "../platform/assistant-launch-payload";
import {
  decodeDeepLinkIntent,
  decodeOsIntent,
  fromAssistantLaunchPayload,
} from "./decode";

describe("decodeOsIntent", () => {
  it("rejects non-objects with not-an-object", () => {
    for (const raw of [null, undefined, 7, "x", [], true]) {
      const res = decodeOsIntent(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("not-an-object");
    }
  });

  it("rejects an unknown type", () => {
    const res = decodeOsIntent({
      type: "explode",
      intentId: "a",
      source: "in-app",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unknown-type");
  });

  it("requires a non-empty intentId", () => {
    const res = decodeOsIntent({
      type: "open-chat",
      intentId: "",
      source: "in-app",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.field).toBe("intentId");
  });

  it("rejects an unknown source", () => {
    const res = decodeOsIntent({
      type: "open-chat",
      intentId: "a",
      source: "mars",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unknown-source");
  });

  it("validates issuedAt is a finite number when present", () => {
    const bad = decodeOsIntent({
      type: "open-chat",
      intentId: "a",
      source: "in-app",
      issuedAt: "soon",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.field).toBe("issuedAt");
    const ok = decodeOsIntent({
      type: "open-chat",
      intentId: "a",
      source: "in-app",
      issuedAt: 123,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.intent.issuedAt).toBe(123);
  });

  it("requires non-empty text for send", () => {
    const empty = decodeOsIntent({
      type: "send",
      intentId: "a",
      source: "in-app",
      text: "",
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.field).toBe("text");
    const ok = decodeOsIntent({
      type: "send",
      intentId: "a",
      source: "in-app",
      text: "hi",
      channelType: "VOICE_DM",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.intent.type === "send") {
      expect(ok.intent.text).toBe("hi");
      expect(ok.intent.channelType).toBe("VOICE_DM");
    }
  });

  it("rejects an invalid send channelType", () => {
    const res = decodeOsIntent({
      type: "send",
      intentId: "a",
      source: "in-app",
      text: "hi",
      channelType: "SMS",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.field).toBe("channelType");
  });

  it("preserves valid send attachments and metadata", () => {
    const result = decodeOsIntent({
      type: "send",
      intentId: "intent-with-image",
      source: "android-share-sheet",
      text: "review this",
      images: [
        {
          data: "aGVsbG8=",
          mimeType: "image/png",
          name: "capture.png",
        },
      ],
      metadata: { sourceApp: "camera" },
    });

    expect(result).toEqual({
      ok: true,
      intent: expect.objectContaining({
        images: [expect.objectContaining({ name: "capture.png" })],
        metadata: { sourceApp: "camera" },
      }),
    });
  });

  it("rejects malformed send attachments and metadata", () => {
    const badImage = decodeOsIntent({
      type: "send",
      intentId: "bad-image",
      source: "android-share-sheet",
      text: "review this",
      images: [{ data: 42, mimeType: "image/png", name: "capture.png" }],
    });
    expect(badImage).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ field: "images" }),
      }),
    );

    const badMetadata = decodeOsIntent({
      type: "send",
      intentId: "bad-metadata",
      source: "android-share-sheet",
      text: "review this",
      metadata: [],
    });
    expect(badMetadata).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ field: "metadata" }),
      }),
    );
  });

  it("requires a valid mode for start-voice", () => {
    const bad = decodeOsIntent({
      type: "start-voice",
      intentId: "a",
      source: "in-app",
      mode: "sing",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.field).toBe("mode");
    const ok = decodeOsIntent({
      type: "start-voice",
      intentId: "a",
      source: "in-app",
      mode: "dictate",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.intent.type === "start-voice")
      expect(ok.intent.mode).toBe("dictate");
  });

  it("decodes the argument-free intents", () => {
    for (const type of [
      "open-chat",
      "stop-voice",
      "start-transcription",
      "stop-transcription",
      "continue-conversation",
    ] as const) {
      const res = decodeOsIntent({ type, intentId: "a", source: "in-app" });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.intent.type).toBe(type);
    }
  });

  it("ignores unknown keys (forward compatibility)", () => {
    const res = decodeOsIntent({
      type: "open-chat",
      intentId: "a",
      source: "in-app",
      futureField: 1,
    });
    expect(res.ok).toBe(true);
  });
});

describe("decodeDeepLinkIntent", () => {
  it("rejects a non-URL", () => {
    const res = decodeDeepLinkIntent("not a url");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not-a-url");
  });

  it("rejects a missing/unknown source", () => {
    const res = decodeDeepLinkIntent("elizaos://chat?action=chat");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unknown-source");
  });

  it("maps the Android CREATE_MESSAGE 'ask' link to a send intent", () => {
    const res = decodeDeepLinkIntent(
      "elizaos://chat?source=android-app-actions&action=ask&text=hello%20there",
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.intent.type === "send") {
      expect(res.intent.text).toBe("hello there");
      expect(res.intent.source).toBe("android-app-actions");
    } else {
      throw new Error("expected send intent");
    }
  });

  it("maps 'chat' with no text to open-chat", () => {
    const res = decodeDeepLinkIntent(
      "elizaos://chat?source=android-static-shortcut&action=chat",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.type).toBe("open-chat");
  });

  it("maps the iOS StartVoice link (voice=1) to start-voice", () => {
    const res = decodeDeepLinkIntent(
      "elizaos://voice?source=ios-app-shortcuts&action=voice&voice=1",
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.intent.type === "start-voice") {
      expect(res.intent.mode).toBe("converse");
    } else {
      throw new Error("expected start-voice intent");
    }
  });

  it.each([
    "ios-app-intents",
    "ios-control",
    "ios-widget",
    "android-assistant-session",
    "android-recognition-service",
    "android-ime",
    "android-widget",
  ] as const)("accepts the native voice source %s", (source) => {
    const res = decodeDeepLinkIntent(
      `elizaos://voice?source=${source}&action=voice&voice=1`,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.type).toBe("start-voice");
  });

  it("maps iOS Live Activity stop/save to stop-transcription before voice=1", () => {
    for (const action of ["stop", "save"]) {
      const res = decodeDeepLinkIntent(
        `elizaos://voice?source=ios-live-activity&action=${action}&voice=1`,
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.intent.type).toBe("stop-transcription");
    }
  });

  it("maps an iOS Live Activity open to conversation continuation", () => {
    const res = decodeDeepLinkIntent(
      "elizaos://voice?source=ios-live-activity&action=open&voice=1",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.type).toBe("continue-conversation");
  });

  it("prefers voice over a chat host when voice=1 is present", () => {
    const res = decodeDeepLinkIntent(
      "elizaos://chat?source=siri&voice=1&action=ask&text=hi",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.type).toBe("start-voice");
  });

  it("maps a transcribe launch to start-transcription", () => {
    const res = decodeDeepLinkIntent(
      "elizaos://transcribe?source=android-quick-settings&action=transcribe",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.type).toBe("start-transcription");
  });

  it("maps a resume link to continue-conversation", () => {
    const res = decodeDeepLinkIntent(
      "elizaos://chat?source=notification&action=resume",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.type).toBe("continue-conversation");
  });

  it("normalizes a mixed-case custom-scheme host", () => {
    const res = decodeDeepLinkIntent(
      "ELIZAOS://Chat?source=macos-shortcuts&action=chat",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.type).toBe("open-chat");
  });

  it("returns unrecognized-launch for a non-owned feature deep link", () => {
    const res = decodeDeepLinkIntent(
      "elizaos://feature/open?source=android-app-actions&feature=x",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unrecognized-launch");
  });

  it("preserves a trusted LifeOps text handoff as a reviewable chat send", () => {
    const res = decodeDeepLinkIntent(
      "elizaos://chat?source=ios-app-shortcuts&action=lifeops.create&text=buy%20milk",
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.intent).toMatchObject({ type: "send", text: "buy milk" });
    }
  });

  it("prefers the explicit assistant.launchId as the dedupe id", () => {
    const res = decodeDeepLinkIntent(
      "elizaos://chat?source=siri&action=ask&text=hi&assistant.launchId=abc-123",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.intentId).toBe("abc-123");
  });

  it("synthesizes a stable dedupe id when none is provided", () => {
    const url = "elizaos://voice?source=ios-app-shortcuts&action=voice&voice=1";
    const a = decodeDeepLinkIntent(url);
    const b = decodeDeepLinkIntent(url);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.intent.intentId).toBe(b.intent.intentId);
  });
});

describe("fromAssistantLaunchPayload", () => {
  const base: AssistantLaunchPayload = {
    action: "ask",
    launchId: "launch-42",
    route: "chat",
    source: "ios-app-shortcuts",
    text: "draft a reply",
  };

  it("adapts a chat-send payload to a send intent keyed on its launchId", () => {
    const res = fromAssistantLaunchPayload(base);
    expect(res.ok).toBe(true);
    if (res.ok && res.intent.type === "send") {
      expect(res.intent.intentId).toBe("launch-42");
      expect(res.intent.text).toBe("draft a reply");
    } else {
      throw new Error("expected send intent");
    }
  });

  it("adapts an action-less open to open-chat", () => {
    const res = fromAssistantLaunchPayload({ ...base, action: null, text: "" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.type).toBe("open-chat");
  });

  it("rejects an unknown source", () => {
    const res = fromAssistantLaunchPayload({ ...base, source: "telepathy" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unknown-source");
  });
});
