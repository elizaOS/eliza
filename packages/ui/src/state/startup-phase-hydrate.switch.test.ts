// @vitest-environment jsdom
//
// Frontend half of the #12178 runtime-switch contract: the bindReadyPhase
// onWsEvent handlers for `shell:model-switch` and `shell:switch-agent`. Uses the
// REAL switchRuntimeNonDestructive (and its real remote-trust gate) + real
// agent-profile registry over jsdom localStorage; only the API client and global
// fetch (the result callback transport) are doubled.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { addAgentProfile } from "./agent-profiles";
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
    getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
    repointBaseUrl: vi.fn(),
    setToken: vi.fn(),
  };
});

vi.mock("../api", () => ({ client: clientMock }));

const setActionNotice = vi.fn();

function makeDeps(): ReadyPhaseDeps {
  return {
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
    setActionNotice,
  };
}

function lastResultBody(): Record<string, unknown> {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("result callback fetch was never called");
  const [url, init] = call as [string, RequestInit];
  expect(String(url)).toContain("/api/runtime/agent-switch/result");
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("bindReadyPhase shell:switch-agent handler", () => {
  beforeEach(() => {
    localStorage.clear();
    clientMock.handlers.clear();
    clientMock.repointBaseUrl.mockClear();
    clientMock.setToken.mockClear();
    setActionNotice.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
  });

  it("refuses an untrusted remote profile and never repoints the client", () => {
    addAgentProfile({
      label: "My VPS",
      kind: "remote",
      apiBase: "https://evil.example.com",
    });
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("shell:switch-agent")?.({
      requestId: "req-untrusted",
      profile: "My VPS",
    });

    // The real trust gate blocked it: no in-place base/token repoint happened.
    expect(clientMock.repointBaseUrl).not.toHaveBeenCalled();
    expect(clientMock.setToken).not.toHaveBeenCalled();
    // The refusal is relayed back to the originating agent and surfaced.
    expect(lastResultBody()).toEqual({
      requestId: "req-untrusted",
      ok: false,
      reason: "untrusted-remote",
    });
    expect(setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("untrusted remote"),
      "error",
    );

    cleanup();
  });

  it("applies a trusted local profile and reports success", () => {
    const laptop = addAgentProfile({
      label: "Laptop",
      kind: "local",
      apiBase: "",
    });
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("shell:switch-agent")?.({
      requestId: "req-local",
      profile: "Laptop",
    });

    // A same-origin local runtime repoints back to the app's own host.
    expect(clientMock.repointBaseUrl).toHaveBeenCalledWith(
      window.location.origin,
    );
    expect(lastResultBody()).toEqual({
      requestId: "req-local",
      ok: true,
      profileId: laptop.id,
      profileLabel: "Laptop",
    });
    expect(setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Laptop"),
      "success",
    );

    cleanup();
  });

  it("reports not-found for an unknown profile query", () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("shell:switch-agent")?.({
      requestId: "req-ghost",
      profile: "does-not-exist",
    });

    expect(clientMock.repointBaseUrl).not.toHaveBeenCalled();
    expect(lastResultBody()).toEqual({
      requestId: "req-ghost",
      ok: false,
      reason: "not-found",
    });

    cleanup();
  });

  it("ignores a switch-agent event with no requestId", () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("shell:switch-agent")?.({ profile: "Laptop" });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(clientMock.repointBaseUrl).not.toHaveBeenCalled();

    cleanup();
  });
});

describe("bindReadyPhase shell:model-switch handler", () => {
  beforeEach(() => {
    clientMock.handlers.clear();
    setActionNotice.mockClear();
  });

  it("surfaces a cloud switch as a success notice", () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("shell:model-switch")?.({
      target: "cloud",
      model: "gemma-4-31b",
      displayName: "Eliza Cloud (gemma-4-31b)",
      status: "ready",
    });

    expect(setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Eliza Cloud"),
      "success",
      undefined,
      false,
      false,
    );

    cleanup();
  });

  it("surfaces a local download as a busy notice", () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("shell:model-switch")?.({
      target: "local",
      model: "eliza-1-2b",
      displayName: "Eliza-1 2B",
      status: "downloading",
    });

    expect(setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("downloading"),
      "success",
      undefined,
      false,
      true,
    );

    cleanup();
  });
});
