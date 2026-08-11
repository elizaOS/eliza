/**
 * End-to-end pipeline tests: a real native `elizaos://…` launch link flows
 * decode → route → drive the ONE controller, and a redelivered link drives it
 * exactly once. This is the full contract a launch surface relies on, exercised
 * without any device — the boundary decoder, the routing authority, the dedupe
 * store, and the executor wired together. Deterministic; injected clock, no I/O.
 */
import { describe, expect, it, vi } from "vitest";
import {
  applyOsIntentCommands,
  type IntentControllerTarget,
} from "./apply-command";
import { decodeDeepLinkIntent } from "./decode";
import { IntentDedupeStore } from "./dedupe";
import { type RoutingContext, routeIntent } from "./router";

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

function spyController(): {
  controller: IntentControllerTarget;
  calls: string[];
} {
  const calls: string[] = [];
  const controller: IntentControllerTarget = {
    open: vi.fn(() => calls.push("open")),
    send: vi.fn((text: string) => calls.push(`send:${text}`)),
    startRecording: vi.fn((intent?: string) =>
      calls.push(`startRecording:${intent}`),
    ),
    stopRecording: vi.fn(() => calls.push("stopRecording")),
    toggleTranscriptionMode: vi.fn(() => {
      calls.push("toggleTranscriptionMode");
    }),
    stopTranscriptionAndMic: vi.fn(() => {
      calls.push("stopTranscriptionAndMic");
    }),
    transcriptionMode: false,
  };
  return { controller, calls };
}

/** Drive one raw launch URL through the whole pipeline against a controller. */
function launch(
  url: string,
  context: RoutingContext,
  store: IntentDedupeStore,
  controller: IntentControllerTarget,
): string {
  const decoded = decodeDeepLinkIntent(url);
  if (!decoded.ok) return `decode:${decoded.error.code}`;
  const outcome = routeIntent(decoded.intent, context, store);
  if (outcome.status === "routed")
    applyOsIntentCommands(controller, outcome.commands);
  return outcome.status;
}

describe("os-intent pipeline", () => {
  it("drives the controller from the iOS StartVoice link", () => {
    const store = new IntentDedupeStore();
    const { controller, calls } = spyController();
    const status = launch(
      "elizaos://voice?source=ios-app-shortcuts&action=voice&voice=1&assistant.launchId=siri-1",
      healthyContext(),
      store,
      controller,
    );
    expect(status).toBe("routed");
    expect(calls).toEqual(["open", "startRecording:converse"]);
  });

  it("drives open+send from the Android CREATE_MESSAGE link", () => {
    const store = new IntentDedupeStore();
    const { controller, calls } = spyController();
    const status = launch(
      "elizaos://chat?source=android-app-actions&action=ask&text=what%20is%20the%20weather&assistant.launchId=aa-1",
      healthyContext(),
      store,
      controller,
    );
    expect(status).toBe("routed");
    expect(calls).toEqual(["open", "send:what is the weather"]);
  });

  it("applies a redelivered launch exactly once (idempotent end to end)", () => {
    const store = new IntentDedupeStore();
    const { controller, calls } = spyController();
    const url =
      "elizaos://voice?source=ios-app-shortcuts&action=voice&voice=1&assistant.launchId=siri-1";

    expect(launch(url, healthyContext(), store, controller)).toBe("routed");
    expect(launch(url, healthyContext({ now: 1_100 }), store, controller)).toBe(
      "duplicate",
    );
    expect(launch(url, healthyContext({ now: 1_200 }), store, controller)).toBe(
      "duplicate",
    );

    // The controller was driven only for the first delivery.
    expect(calls).toEqual(["open", "startRecording:converse"]);
  });

  it("does not touch the controller when the launch is blocked", () => {
    const store = new IntentDedupeStore();
    const { controller, calls } = spyController();
    const status = launch(
      "elizaos://voice?source=siri&action=voice&voice=1&assistant.launchId=v1",
      healthyContext({ device: { locked: true, foreground: true } }),
      store,
      controller,
    );
    expect(status).toBe("blocked");
    expect(calls).toEqual([]);
  });

  it("leaves a non-owned deep link for the caller (decode rejects it)", () => {
    const store = new IntentDedupeStore();
    const { controller, calls } = spyController();
    const status = launch(
      "elizaos://feature/open?source=android-app-actions&feature=settings",
      healthyContext(),
      store,
      controller,
    );
    expect(status).toBe("decode:unrecognized-launch");
    expect(calls).toEqual([]);
  });

  it("drives stop-voice through the pipeline to exactly one controller stop", () => {
    const store = new IntentDedupeStore();
    const { controller, calls } = spyController();
    const status = launch(
      "elizaos://voice?source=ios-app-shortcuts&action=stop-voice",
      healthyContext(),
      store,
      controller,
    );
    expect(status).toBe("routed");
    expect(calls).toEqual(["stopRecording"]);

    // A second delivery with a different intentId must still only drive one stop
    // when deduped; the controller-level idempotency covers same-id redelivery
    const secondStatus = launch(
      "elizaos://voice?source=ios-app-shortcuts&action=stop-voice&assistant.launchId=stop-2",
      healthyContext({ now: 2_000 }),
      store,
      controller,
    );
    expect(secondStatus).toBe("routed");
    expect(calls).toEqual(["stopRecording", "stopRecording"]);
  });
});
