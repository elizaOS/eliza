// @vitest-environment jsdom

// Closes the renderer half of the transcripts/voice-control round-trip that
// #10280's `transcript-realaudio.spec.ts` scope note explicitly deferred to
// #9958: the server `START`/`STOP_TRANSCRIPTION` agent action emits an
// `AGENT_EVENT` with `stream: "voice-control"`, which arrives at the renderer as
// a websocket `agent_event`. This asserts that envelope is re-dispatched to the
// shell as an `eliza:voice-control` window event (and that malformed/non
// voice-control envelopes are not).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_CONTROL_EVENT } from "../events";
import { bindReadyPhase, type ReadyPhaseDeps } from "./startup-phase-hydrate";

const clientMock = vi.hoisted(() => {
  const handlers = new Map<string, (data: Record<string, unknown>) => void>();
  return {
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    getCodingAgentStatus: vi.fn(async () => ({ tasks: [] })),
    handlers,
    onWsEvent: vi.fn(
      (event: string, handler: (data: Record<string, unknown>) => void) => {
        handlers.set(event, handler);
        return () => {
          handlers.delete(event);
        };
      },
    ),
    sendWsMessage: vi.fn(),
  };
});

vi.mock("../api", () => ({
  client: clientMock,
}));

function makeDeps(): ReadyPhaseDeps {
  return {
    setActionNotice: vi.fn(),
    setAgentStatusIfChanged: vi.fn(),
    setPendingRestart: vi.fn(),
    setPendingRestartReasons: vi.fn(),
    setSystemWarnings: vi.fn(),
    showRestartBanner: vi.fn(),
    setPtySessions: vi.fn(),
    hasPtySessionsRef: { current: false },
    agentRunningRef: { current: false },
    setTabRaw: vi.fn(),
    setConversationMessages: vi.fn(),
    setUnreadConversations: vi.fn(),
    setConversations: vi.fn(),
    appendAutonomousEvent: vi.fn(),
    notifyHeartbeatEvent: vi.fn(),
    loadPlugins: vi.fn(async () => {}),
    loadWalletConfig: vi.fn(async () => {}),
    pollCloudCredits: vi.fn(),
    activeConversationIdRef: { current: null },
    elizaCloudPollInterval: { current: null },
    elizaCloudLoginPollTimer: { current: null },
  };
}

describe("bindReadyPhase voice-control agent-event bridge", () => {
  let voiceHandler: EventListener;
  let voiceHandlerMock: ReturnType<typeof vi.fn<(event: Event) => void>>;

  beforeEach(() => {
    clientMock.handlers.clear();
    clientMock.onWsEvent.mockClear();
    clientMock.disconnectWs.mockClear();
    voiceHandlerMock = vi.fn();
    voiceHandler = (event) => voiceHandlerMock(event);
    window.addEventListener(VOICE_CONTROL_EVENT, voiceHandler);
  });

  function teardown(cleanup: () => void) {
    cleanup();
    window.removeEventListener(VOICE_CONTROL_EVENT, voiceHandler);
  }

  it("re-dispatches a START_TRANSCRIPTION voice-control agent_event to the shell", () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("agent_event")?.({
      stream: "voice-control",
      payload: { command: "start" },
    });

    expect(voiceHandlerMock).toHaveBeenCalledTimes(1);
    const event = voiceHandlerMock.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ command: "start" });

    teardown(cleanup);
    expect(clientMock.handlers.has("agent_event")).toBe(false);
  });

  it("re-dispatches a STOP_TRANSCRIPTION voice-control agent_event to the shell", () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("agent_event")?.({
      stream: "voice-control",
      payload: { command: "stop" },
    });

    expect(voiceHandlerMock).toHaveBeenCalledTimes(1);
    const event = voiceHandlerMock.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ command: "stop" });

    teardown(cleanup);
  });

  it("ignores a voice-control agent_event with an unknown command", () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("agent_event")?.({
      stream: "voice-control",
      payload: { command: "pause" },
    });
    clientMock.handlers.get("agent_event")?.({
      stream: "voice-control",
      payload: {},
    });

    expect(voiceHandlerMock).not.toHaveBeenCalled();

    teardown(cleanup);
  });

  it("does not treat a non voice-control agent_event as a voice-control command", () => {
    const deps = makeDeps();
    const cleanup = bindReadyPhase({ current: deps });

    clientMock.handlers.get("agent_event")?.({
      stream: "trajectory",
      payload: { command: "start" },
    });

    expect(voiceHandlerMock).not.toHaveBeenCalled();

    teardown(cleanup);
  });
});
