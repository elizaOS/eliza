/**
 * Routing-authority unit tests — the full case matrix from #16441: routed happy
 * paths per intent, invalid/stale intents, locked device, missing permissions,
 * auth expiry, background/foreground, auto-start consent gating + reversibility,
 * concurrency (interleaved routing over one shared store), duplicate-start
 * prevention across redelivery paths, and crash recovery via snapshot rehydrate.
 * Deterministic; injected clock, no I/O.
 */
import { describe, expect, it } from "vitest";
import type { OsIntent } from "./contract";
import { IntentDedupeStore } from "./dedupe";
import { type RoutingContext, routeIntent } from "./router";

/** A context in which every prerequisite is satisfied and consent is granted. */
function healthyContext(
  overrides: Partial<RoutingContext> = {},
): RoutingContext {
  return {
    now: 1_000,
    auth: "authenticated",
    device: { locked: false, foreground: true },
    capabilities: {
      voiceCapture: true,
      sandboxed: false,
      microphone: "granted",
    },
    consent: { autoStartVoice: true, autoStartTranscription: true },
    ...overrides,
  };
}

function intent(partial: Partial<OsIntent> & Pick<OsIntent, "type">): OsIntent {
  return { intentId: "id-1", source: "in-app", ...partial } as OsIntent;
}

describe("routeIntent — routed happy paths", () => {
  it("open-chat → open command", () => {
    const out = routeIntent(
      intent({ type: "open-chat" }),
      healthyContext(),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("routed");
    if (out.status === "routed") {
      expect(out.target).toBe("chat");
      expect(out.commands).toEqual([{ kind: "open" }]);
    }
  });

  it("send → open then send, carrying channelType", () => {
    const out = routeIntent(
      {
        type: "send",
        intentId: "s",
        source: "siri",
        text: "hi",
        channelType: "VOICE_DM",
      },
      healthyContext(),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("routed");
    if (out.status === "routed") {
      expect(out.commands).toEqual([
        { kind: "open" },
        { kind: "send", text: "hi", channelType: "VOICE_DM" },
      ]);
    }
  });

  it("start-voice (dictate) → open then startRecording(dictate)", () => {
    const out = routeIntent(
      {
        type: "start-voice",
        intentId: "v",
        source: "ios-app-shortcuts",
        mode: "dictate",
      },
      healthyContext(),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("routed");
    if (out.status === "routed") {
      expect(out.target).toBe("voice");
      expect(out.commands).toEqual([
        { kind: "open" },
        { kind: "startRecording", intent: "dictate" },
      ]);
    }
  });

  it("start-transcription → open then toggleTranscriptionMode", () => {
    const out = routeIntent(
      intent({ type: "start-transcription" }),
      healthyContext(),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("routed");
    if (out.status === "routed") {
      expect(out.commands).toEqual([
        { kind: "open" },
        { kind: "toggleTranscriptionMode" },
      ]);
    }
  });

  it("continue-conversation → open", () => {
    const out = routeIntent(
      intent({ type: "continue-conversation" }),
      healthyContext(),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("routed");
    if (out.status === "routed")
      expect(out.commands).toEqual([{ kind: "open" }]);
  });
});

describe("routeIntent — stale + invalid", () => {
  it("rejects an intent older than maxIntentAgeMs", () => {
    const out = routeIntent(
      { type: "open-chat", intentId: "x", source: "notification", issuedAt: 0 },
      healthyContext({ now: 10_000, maxIntentAgeMs: 5_000 }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("stale");
    if (out.status === "stale") expect(out.ageMs).toBe(10_000);
  });

  it("does not treat a future issuedAt (clock skew) as stale", () => {
    const out = routeIntent(
      {
        type: "open-chat",
        intentId: "x",
        source: "notification",
        issuedAt: 20_000,
      },
      healthyContext({ now: 10_000, maxIntentAgeMs: 5_000 }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("routed");
  });

  it("does not apply staleness when issuedAt is absent", () => {
    const out = routeIntent(
      { type: "open-chat", intentId: "x", source: "notification" },
      healthyContext({ maxIntentAgeMs: 1 }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("routed");
  });
});

describe("routeIntent — blocked prerequisites (recoverable)", () => {
  it("blocks send when unauthenticated", () => {
    const out = routeIntent(
      intent({ type: "send", text: "hi" }),
      healthyContext({ auth: "unauthenticated" }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("blocked");
    if (out.status === "blocked") {
      expect(out.reason).toBe("unauthenticated");
      expect(out.missing).toContain("session");
    }
  });

  it("distinguishes an expired session from an absent one", () => {
    const out = routeIntent(
      intent({ type: "open-chat" }),
      healthyContext({ auth: "expired" }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("blocked");
    if (out.status === "blocked") expect(out.reason).toBe("auth-expired");
  });

  it("blocks start-voice on a locked device", () => {
    const out = routeIntent(
      { type: "start-voice", intentId: "v", source: "siri", mode: "converse" },
      healthyContext({ device: { locked: true, foreground: true } }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("blocked");
    if (out.status === "blocked") expect(out.reason).toBe("locked");
  });

  it("blocks auto-start capture while backgrounded", () => {
    const out = routeIntent(
      intent({ type: "start-transcription" }),
      healthyContext({ device: { locked: false, foreground: false } }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("blocked");
    if (out.status === "blocked") expect(out.reason).toBe("backgrounded");
  });

  it("blocks start-voice when the mic permission is denied", () => {
    const out = routeIntent(
      { type: "start-voice", intentId: "v", source: "siri", mode: "converse" },
      healthyContext({
        capabilities: {
          voiceCapture: true,
          sandboxed: false,
          microphone: "denied",
        },
      }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("blocked");
    if (out.status === "blocked") expect(out.reason).toBe("microphone-denied");
  });

  it("does NOT block on mic 'prompt'/'unknown' (capture-time prompt is allowed)", () => {
    for (const microphone of ["prompt", "unknown"] as const) {
      const out = routeIntent(
        {
          type: "start-voice",
          intentId: `v-${microphone}`,
          source: "siri",
          mode: "converse",
        },
        healthyContext({
          capabilities: { voiceCapture: true, sandboxed: false, microphone },
        }),
        new IntentDedupeStore(),
      );
      expect(out.status).toBe("routed");
    }
  });

  it("reports the highest-priority reason but lists ALL missing prerequisites", () => {
    const out = routeIntent(
      { type: "start-voice", intentId: "v", source: "siri", mode: "converse" },
      healthyContext({
        auth: "unauthenticated",
        device: { locked: true, foreground: false },
        capabilities: {
          voiceCapture: true,
          sandboxed: false,
          microphone: "denied",
        },
      }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("blocked");
    if (out.status === "blocked") {
      expect(out.reason).toBe("unauthenticated"); // session is first in declaration order
      expect(out.missing).toEqual([
        "session",
        "unlocked",
        "foreground",
        "microphone",
      ]);
    }
  });

  it("a blocked intent is NOT recorded — retry after fixing the prerequisite routes", () => {
    const store = new IntentDedupeStore();
    const blocked = routeIntent(
      { type: "start-voice", intentId: "v", source: "siri", mode: "converse" },
      healthyContext({
        capabilities: {
          voiceCapture: true,
          sandboxed: false,
          microphone: "denied",
        },
      }),
      store,
    );
    expect(blocked.status).toBe("blocked");
    const retried = routeIntent(
      { type: "start-voice", intentId: "v", source: "siri", mode: "converse" },
      healthyContext(),
      store,
    );
    expect(retried.status).toBe("routed");
  });
});

describe("routeIntent — degraded (device cannot honor)", () => {
  it("degrades start-voice when voice capture is unsupported", () => {
    const out = routeIntent(
      { type: "start-voice", intentId: "v", source: "siri", mode: "converse" },
      healthyContext({
        capabilities: {
          voiceCapture: false,
          sandboxed: false,
          microphone: "granted",
        },
      }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("degraded");
    if (out.status === "degraded") expect(out.reason).toBe("voice-unsupported");
  });

  it("degrades an auto-start on a sandboxed device", () => {
    const out = routeIntent(
      intent({ type: "start-transcription" }),
      healthyContext({
        capabilities: {
          voiceCapture: true,
          sandboxed: true,
          microphone: "granted",
        },
      }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("degraded");
    if (out.status === "degraded") expect(out.reason).toBe("sandboxed");
  });

  it("chat intents never degrade on missing voice support", () => {
    const out = routeIntent(
      intent({ type: "open-chat" }),
      healthyContext({
        capabilities: {
          voiceCapture: false,
          sandboxed: true,
          microphone: "denied",
        },
      }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("routed");
  });
});

describe("routeIntent — stop-* is always allowed (reversibility)", () => {
  it("routes stop-voice even when locked, denied, and unauthenticated", () => {
    const out = routeIntent(
      { type: "stop-voice", intentId: "sv", source: "in-app" },
      healthyContext({
        auth: "unauthenticated",
        device: { locked: true, foreground: false },
        capabilities: {
          voiceCapture: false,
          sandboxed: true,
          microphone: "denied",
        },
      }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("routed");
    if (out.status === "routed")
      expect(out.commands).toEqual([{ kind: "stopRecording" }]);
  });

  it("routes stop-transcription unconditionally", () => {
    const out = routeIntent(
      { type: "stop-transcription", intentId: "st", source: "in-app" },
      healthyContext({
        capabilities: {
          voiceCapture: false,
          sandboxed: true,
          microphone: "denied",
        },
      }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("routed");
    if (out.status === "routed")
      expect(out.commands).toEqual([{ kind: "stopTranscriptionAndMic" }]);
  });
});

describe("routeIntent — auto-start consent", () => {
  it("requires consent for start-voice when not granted", () => {
    const out = routeIntent(
      { type: "start-voice", intentId: "v", source: "siri", mode: "converse" },
      healthyContext({
        consent: { autoStartVoice: false, autoStartTranscription: true },
      }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("consent-required");
    if (out.status === "consent-required") expect(out.target).toBe("voice");
  });

  it("requires consent for start-transcription independently", () => {
    const out = routeIntent(
      intent({ type: "start-transcription" }),
      healthyContext({
        consent: { autoStartVoice: true, autoStartTranscription: false },
      }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("consent-required");
  });

  it("routes once consent is granted (reversible gate)", () => {
    const out = routeIntent(
      { type: "start-voice", intentId: "v", source: "siri", mode: "converse" },
      healthyContext({
        consent: { autoStartVoice: true, autoStartTranscription: true },
      }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("routed");
  });

  it("never gates non-auto-start intents on consent", () => {
    const out = routeIntent(
      intent({ type: "open-chat" }),
      healthyContext({
        consent: { autoStartVoice: false, autoStartTranscription: false },
      }),
      new IntentDedupeStore(),
    );
    expect(out.status).toBe("routed");
  });
});

describe("routeIntent — duplicate-start prevention + concurrency", () => {
  it("lets the live authority record only after command execution succeeds", () => {
    const store = new IntentDedupeStore();
    const deferred = routeIntent(
      intent({ type: "open-chat", intentId: "commit-after-apply" }),
      healthyContext(),
      store,
      { record: false },
    );
    expect(deferred.status).toBe("routed");
    expect(store.has("commit-after-apply", 1_000)).toBe(false);

    store.record("commit-after-apply", 1_000);
    expect(
      routeIntent(
        intent({ type: "open-chat", intentId: "commit-after-apply" }),
        healthyContext(),
        store,
      ).status,
    ).toBe("duplicate");
  });

  it("dedupes the same intentId (retried deep link / re-tapped notification)", () => {
    const store = new IntentDedupeStore();
    const first = routeIntent(
      intent({ type: "open-chat", intentId: "dup" }),
      healthyContext(),
      store,
    );
    const second = routeIntent(
      intent({ type: "open-chat", intentId: "dup" }),
      healthyContext(),
      store,
    );
    expect(first.status).toBe("routed");
    expect(second.status).toBe("duplicate");
    if (second.status === "duplicate")
      expect(second.firstAppliedAt).toBe(1_000);
  });

  it("prevents a duplicate start across two windows sharing one store", () => {
    const store = new IntentDedupeStore();
    const windowA = routeIntent(
      {
        type: "start-voice",
        intentId: "launch",
        source: "siri",
        mode: "converse",
      },
      healthyContext(),
      store,
    );
    const windowB = routeIntent(
      {
        type: "start-voice",
        intentId: "launch",
        source: "siri",
        mode: "converse",
      },
      healthyContext(),
      store,
    );
    expect(windowA.status).toBe("routed");
    expect(windowB.status).toBe("duplicate");
  });

  it("routes distinct intentIds independently under interleaving", () => {
    const store = new IntentDedupeStore();
    const results = ["a", "b", "a", "c", "b"].map(
      (id) =>
        routeIntent(
          intent({ type: "open-chat", intentId: id }),
          healthyContext(),
          store,
        ).status,
    );
    expect(results).toEqual([
      "routed",
      "routed",
      "duplicate",
      "routed",
      "duplicate",
    ]);
    expect(store.size).toBe(3);
  });

  it("stale is decided before dedupe (a stale duplicate reports stale)", () => {
    const store = new IntentDedupeStore();
    routeIntent(
      {
        type: "open-chat",
        intentId: "x",
        source: "notification",
        issuedAt: 1_000,
      },
      healthyContext({ now: 1_000 }),
      store,
    );
    const stale = routeIntent(
      { type: "open-chat", intentId: "x", source: "notification", issuedAt: 0 },
      healthyContext({ now: 10_000, maxIntentAgeMs: 5_000 }),
      store,
    );
    expect(stale.status).toBe("stale");
  });
});

describe("routeIntent — crash recovery", () => {
  it("a restored session seeded from a snapshot does not re-fire a handled launch", () => {
    const live = new IntentDedupeStore();
    routeIntent(
      {
        type: "start-voice",
        intentId: "boot-launch",
        source: "ios-app-shortcuts",
        mode: "converse",
      },
      healthyContext(),
      live,
    );
    const snapshot = live.snapshot(1_000);

    // App crashes and reopens; the OS redelivers the same launch to a fresh store.
    const restored = new IntentDedupeStore({ seed: snapshot });
    const out = routeIntent(
      {
        type: "start-voice",
        intentId: "boot-launch",
        source: "ios-app-shortcuts",
        mode: "converse",
      },
      healthyContext(),
      restored,
    );
    expect(out.status).toBe("duplicate");
  });
});
