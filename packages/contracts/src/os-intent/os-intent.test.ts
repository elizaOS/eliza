import { describe, expect, it } from "vitest";
import { decodeOsIntent } from "./decode";
import { IntentDedupeStore } from "./dedupe";
import { type RoutingContext, routeIntent } from "./router";

const context: RoutingContext = {
  now: 1000,
  auth: "authenticated",
  device: { locked: false, foreground: true },
  capabilities: { voiceCapture: true, sandboxed: false, microphone: "granted" },
  consent: { autoStartVoice: false, autoStartTranscription: false },
};

describe("OS intent boundary and authority", () => {
  it("rejects malformed input without admitting a partial intent", () => {
    for (const input of [
      null,
      {},
      { type: "send", source: "untrusted", intentId: "id", text: "hello" },
      { type: "send", source: "in-app", intentId: "id", text: 123 },
    ]) {
      expect(decodeOsIntent(input).ok).toBe(false);
    }
  });

  it("preserves a send payload and its transcript attachment identity", () => {
    const intent = {
      type: "send",
      intentId: "send-1",
      source: "in-app",
      text: "Complete message",
      images: [
        {
          data: "YWJj",
          mimeType: "image/png",
          name: "image.png",
          transcriptId: "transcript-1",
        },
      ],
    };
    expect(decodeOsIntent(intent)).toEqual({ ok: true, intent });
  });

  it("requires consent without consuming the intent, then deduplicates across restoration", () => {
    const intent = {
      type: "start-voice",
      intentId: "voice-1",
      source: "siri",
      mode: "converse",
    } as const;
    const store = new IntentDedupeStore();
    expect(routeIntent(intent, context, store).status).toBe("consent-required");
    expect(store.size).toBe(0);
    const approved = {
      ...context,
      consent: { ...context.consent, autoStartVoice: true },
    };
    expect(routeIntent(intent, approved, store)).toMatchObject({
      status: "routed",
      commands: [
        { kind: "open" },
        { kind: "startRecording", intent: "converse" },
      ],
    });
    const restored = new IntentDedupeStore({
      seed: store.snapshot(context.now),
    });
    expect(routeIntent(intent, approved, restored)).toMatchObject({
      status: "duplicate",
      firstAppliedAt: context.now,
    });
  });

  it("allows stopping capture even after authentication, permission and consent are revoked", () => {
    const unavailable: RoutingContext = {
      ...context,
      auth: "expired",
      device: { locked: true, foreground: false },
      capabilities: {
        voiceCapture: false,
        sandboxed: true,
        microphone: "denied",
      },
    };
    for (const type of ["stop-voice", "stop-transcription"] as const) {
      expect(
        routeIntent(
          { type, intentId: type, source: "in-app" },
          unavailable,
          new IntentDedupeStore(),
        ).status,
      ).toBe("routed");
    }
  });
});
