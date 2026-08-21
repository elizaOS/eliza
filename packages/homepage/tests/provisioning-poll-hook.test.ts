/**
 * Hook-level test for the shared-onboarding provisioning poll.
 *
 * Mounts useElizaAppProvisioningChat with a shared onboarding session id,
 * controls elizacloudAuthFetch via mock.module, and proves:
 * - the immediate (mount) request carries statusOnly:true with no message
 * - the 5-second retry carries statusOnly:true with no message
 * - the returned transcript has no poll-generated duplicate assistant replies
 * - polling observes canonical target changes after readiness
 * - concurrent ready responses append one handoff receipt
 * - cleanup on a terminal state or unmount stops further polling
 *
 * Uses jsdom (already a root devDependency) to provide the DOM React needs,
 * and controllable timer shims so tests advance the 5 s poll timeout
 * deterministically without real-time waits.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const nativeSetTimeout = globalThis.setTimeout;

// Capture every fetch invocation so tests can assert on the request body.
const fetchCalls: Array<{ url: string; method: string; body: unknown }> = [];

// The mock returns a provisioning-pending response so the poll loop keeps
// running until the test deliberately flips the status to "running".
let nextStatus = "pending";
let runningHasBridge = true;
let runningAgentId = "agent-123";
let runningBridgeUrl = "https://agent-123.example";
let statusResponseSuccess = true;
let releaseStatusResponse: (() => void) | null = null;
let legacyStatusAgentId: string | null = null;
let legacyStatusBridgeUrl: string | null = null;
let legacyStatusResponseBarrier: Promise<void> | null = null;
let legacyChatStatus = "running";
let legacyChatAgentId: string | null = null;
let legacyChatBridgeUrl: string | null = null;

// --- Controllable poll scheduler ---
// Production recursively schedules setTimeout(cb, 5000). We capture the
// callback so tests can fire it on demand and track which timers were cleared.
interface CapturedTimer {
  callback: () => void;
  cleared: boolean;
  delay: number;
}
let capturedTimers: CapturedTimer[] = [];
let activeTimers: Set<CapturedTimer> = new Set();
let activeWindow: (Window & typeof globalThis) | null = null;

// mock.module intercepts the import inside use-eliza-app-provisioning-chat.ts.
// The source file uses the @/ alias (resolved by Vite/tsconfig to src/), so we
// register the mock under both the alias path and the relative path.
const clientMock = {
  elizacloudAuthFetch: mock(async (url: string, init?: RequestInit) => {
    const bodyStr = init?.body as string | undefined;
    let parsedBody: unknown;
    if (bodyStr) {
      try {
        parsedBody = JSON.parse(bodyStr);
      } catch {
        parsedBody = bodyStr;
      }
    }
    fetchCalls.push({
      url,
      method: init?.method?.toUpperCase() ?? "GET",
      body: parsedBody,
    });

    if (url === "/api/eliza-app/provisioning-agent") {
      await legacyStatusResponseBarrier;
      if (releaseStatusResponse) {
        await new Promise<void>((resolve) => {
          const release = releaseStatusResponse;
          releaseStatusResponse = () => {
            release?.();
            resolve();
          };
        });
      }
      return {
        success: statusResponseSuccess,
        data: {
          status: nextStatus,
          agentId: legacyStatusAgentId,
          bridgeUrl: legacyStatusBridgeUrl,
        },
      };
    }

    if (url === "/api/eliza-app/provisioning-agent/chat") {
      return {
        success: true,
        data: {
          reply: "Canonical target refreshed.",
          containerStatus: legacyChatStatus,
          agentId: legacyChatAgentId,
          bridgeUrl: legacyChatBridgeUrl,
        },
      };
    }

    if (url === "/api/eliza-app/onboarding/chat") {
      const isStatusOnly =
        typeof parsedBody === "object" &&
        parsedBody !== null &&
        (parsedBody as Record<string, unknown>).statusOnly === true;

      // When the test sets nextStatus to "running", include a bridgeUrl so
      // the hook transitions to isReady and stops the poll timer.
      const isRunning = nextStatus === "running";
      return {
        success: true,
        data: {
          reply: isStatusOnly
            ? "on it, your agent is spinning up now."
            : "Hi! I'm Eliza.",
          provisioning: {
            status: nextStatus,
            agentId: isRunning ? runningAgentId : null,
            bridgeUrl: isRunning && runningHasBridge ? runningBridgeUrl : null,
          },
          messages: [
            {
              role: "assistant" as const,
              content: "Hi! I'm Eliza.",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
          handoffComplete: false,
        },
      };
    }

    return { success: true, data: {} };
  }),
};
// Register mocks for the @/-prefixed modules the hook imports.
// bun:test does not read tsconfig.app.json (where the Vite "@" alias lives),
// so we use mock.module to intercept both the alias form and the real path.
mock.module("@/lib/api/client", () => clientMock);
// provisioning-poll-body is a pure function — let the real module load but
// intercept the alias so it resolves.
mock.module("@/lib/provisioning-poll-body", () =>
  import("../src/lib/provisioning-poll-body").then((m) => m),
);

// Import after mocks are registered.
const { useElizaAppProvisioningChat } = await import(
  "../src/lib/hooks/use-eliza-app-provisioning-chat"
);
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { JSDOM } = await import("jsdom");

function setupDom() {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  g.navigator = window.navigator;
  g.HTMLElement = window.HTMLElement;
  g.localStorage = window.localStorage;

  // Override the window timer used by the hook without changing Bun's global
  // test timeout or React's scheduler.
  window.setTimeout = ((callback: () => void, delay: number) => {
    const timer: CapturedTimer = { callback, cleared: false, delay };
    capturedTimers.push(timer);
    activeTimers.add(timer);
    return timer as unknown as number;
  }) as unknown as typeof setTimeout;
  window.clearTimeout = ((id: number) => {
    const timer = id as unknown as CapturedTimer;
    timer.cleared = true;
    activeTimers.delete(timer);
  }) as unknown as typeof clearTimeout;

  activeWindow = window as unknown as Window & typeof globalThis;
  return activeWindow;
}

/** Fire all active (non-cleared) poll callbacks once. */
async function tickPollTimers() {
  const timers = [...activeTimers];
  for (const timer of timers) {
    if (!timer.cleared) {
      // Browser one-shot timers are no longer active once their callback
      // begins; mirror that behavior before the callback schedules a retry.
      activeTimers.delete(timer);
      await timer.callback();
    }
  }
}

function waitForEffects(delay: number) {
  return new Promise<void>((resolve) => nativeSetTimeout(resolve, delay));
}

interface ObservedState {
  messages: Array<{ role: string; content: string }>;
  containerStatus: string;
  isReady: boolean;
  provisioningError: string | null;
  hasObservedStatus: boolean;
  bridgeUrl: string | null;
  agentId: string | null;
  sendMessage: (content: string) => Promise<void>;
}

function mountHook(
  active: boolean,
  sessionId: string | null,
): { getState: () => ObservedState; unmount: () => void } {
  const window = (globalThis as unknown as { window: Window }).window;
  let state: ObservedState = {
    messages: [],
    containerStatus: "pending",
    isReady: false,
    provisioningError: null,
    hasObservedStatus: false,
    bridgeUrl: null,
    agentId: null,
    sendMessage: async () => undefined,
  };

  function TestHarness() {
    const result = useElizaAppProvisioningChat(active, sessionId);
    React.useEffect(() => {
      state = {
        messages: result.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        containerStatus: result.containerStatus,
        isReady: result.isReady,
        provisioningError: result.provisioningError,
        hasObservedStatus: result.hasObservedStatus,
        bridgeUrl: result.bridgeUrl,
        agentId: result.agentId,
        sendMessage: result.sendMessage,
      };
    });
    return React.createElement("div");
  }

  const container = window.document.getElementById("root");
  if (!container) throw new Error("root element not found");
  // Clear any previous render (container is a known empty div from setupDom)
  container.textContent = "";
  const root = createRoot(container);
  root.render(React.createElement(TestHarness));

  return {
    getState: () => state,
    unmount: () => root.unmount(),
  };
}

describe("useElizaAppProvisioningChat — shared onboarding poll", () => {
  beforeEach(() => {
    setupDom();
    fetchCalls.length = 0;
    nextStatus = "pending";
    runningHasBridge = true;
    runningAgentId = "agent-123";
    runningBridgeUrl = "https://agent-123.example";
    statusResponseSuccess = true;
    releaseStatusResponse = null;
    legacyStatusAgentId = null;
    legacyStatusBridgeUrl = null;
    legacyStatusResponseBarrier = null;
    legacyChatStatus = "running";
    legacyChatAgentId = null;
    legacyChatBridgeUrl = null;
    capturedTimers = [];
    activeTimers = new Set();
  });

  afterEach(() => {
    activeWindow?.close();
    activeWindow = null;
  });

  test("organic mount reads status with GET and stops when Dedicated compute is off", async () => {
    nextStatus = "none";
    const { getState, unmount } = mountHook(true, null);

    await waitForEffects(300);

    const statusCalls = fetchCalls.filter(
      (call) => call.url === "/api/eliza-app/provisioning-agent",
    );
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls.every((call) => call.method === "GET")).toBe(true);
    expect(fetchCalls.some((call) => call.method === "POST")).toBe(false);
    expect(getState().containerStatus).toBe("none");
    expect([...activeTimers].filter((timer) => !timer.cleared)).toHaveLength(0);

    unmount();
  });

  test("a failed initial status read cannot reach legacy chat", async () => {
    statusResponseSuccess = false;
    const { getState, unmount } = mountHook(true, null);

    await waitForEffects(150);
    await getState().sendMessage("hello");

    expect(getState().hasObservedStatus).toBe(false);
    expect(
      fetchCalls.filter(
        (call) =>
          call.url === "/api/eliza-app/provisioning-agent/chat" &&
          call.method === "POST",
      ),
    ).toHaveLength(0);

    unmount();
  });

  test("a pending initial status read cannot reach legacy chat", async () => {
    releaseStatusResponse = () => undefined;
    const { getState, unmount } = mountHook(true, null);

    await waitForEffects(50);
    await getState().sendMessage("hello");

    expect(getState().hasObservedStatus).toBe(false);
    expect(
      fetchCalls.filter(
        (call) =>
          call.url === "/api/eliza-app/provisioning-agent/chat" &&
          call.method === "POST",
      ),
    ).toHaveLength(0);

    releaseStatusResponse?.();
    await waitForEffects(50);
    unmount();
  });

  test("legacy chat clears a disappeared canonical target while polling continues", async () => {
    nextStatus = "running";
    legacyStatusAgentId = "agent-a";
    legacyStatusBridgeUrl = "https://agent-a.example";
    const { getState, unmount } = mountHook(true, null);

    await waitForEffects(150);

    expect(getState().isReady).toBe(true);
    expect(getState().agentId).toBe("agent-a");
    expect(getState().bridgeUrl).toBe("https://agent-a.example");
    expect(
      [...activeTimers].filter((timer) => !timer.cleared).length,
    ).toBeGreaterThanOrEqual(1);

    legacyChatStatus = "none";
    legacyChatAgentId = null;
    legacyChatBridgeUrl = null;
    await getState().sendMessage("Are you still there?");
    await waitForEffects(50);

    expect(getState().containerStatus).toBe("none");
    expect(getState().agentId).toBeNull();
    expect(getState().bridgeUrl).toBeNull();
    expect(getState().isReady).toBe(false);

    unmount();
  });

  test("deletion failure is terminal and cannot time out", async () => {
    nextStatus = "deletion_failed";
    const { getState, unmount } = mountHook(true, null);

    await waitForEffects(150);

    expect(getState().containerStatus).toBe("deletion_failed");
    expect(getState().provisioningError).toBe(
      "Removing your previous Dedicated agent failed. Contact support.",
    );
    expect([...activeTimers].filter((timer) => !timer.cleared)).toHaveLength(0);
    unmount();
  });

  test("immediate poll sends statusOnly:true with no message field", async () => {
    const { unmount } = mountHook(true, "platform:blooio:+123****7890");

    // Wait for the mount effect + immediate poll to fire.
    await waitForEffects(150);

    const chatCalls = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    );

    // The polling effect fires immediately on mount. That call uses
    // buildProvisioningPollBody which must carry statusOnly:true.
    const pollCalls = chatCalls.filter((c) => {
      const body = c.body as Record<string, unknown> | undefined;
      return body?.statusOnly === true;
    });

    expect(pollCalls).toHaveLength(1);

    // Every poll call must have statusOnly:true and must NOT have a message field
    for (const call of pollCalls) {
      const body = call.body as Record<string, unknown>;
      expect(body.statusOnly).toBe(true);
      expect(body).not.toHaveProperty("message");
    }

    // The poll body must include the sessionId and correct platform
    const firstPoll = pollCalls[0].body as Record<string, unknown>;
    expect(firstPoll.sessionId).toBe("platform:blooio:+123****7890");
    expect(firstPoll.platform).toBe("blooio");

    unmount();
  });

  test.each(["pending", "provisioning", "error"])(
    "applies authoritative %s status to the continuation state",
    async (status) => {
      nextStatus = status;
      const { getState, unmount } = mountHook(
        true,
        "platform:blooio:+123****7890",
      );

      await waitForEffects(150);

      expect(getState().containerStatus).toBe(status);
      expect(getState().hasObservedStatus).toBe(true);
      unmount();
    },
  );

  test("applies running status without a bridge as authoritative but not ready", async () => {
    nextStatus = "running";
    runningHasBridge = false;
    const { getState, unmount } = mountHook(
      true,
      "platform:blooio:+123****7890",
    );

    await waitForEffects(150);

    expect(getState().containerStatus).toBe("running");
    expect(getState().hasObservedStatus).toBe(true);
    expect(getState().isReady).toBe(false);
    unmount();
  });

  test("5-second retry also sends statusOnly:true with no message", async () => {
    const { unmount } = mountHook(true, "platform:blooio:+123****7890");

    // Wait for mount + immediate poll.
    await waitForEffects(150);

    const callsAfterImmediate = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // The hook must have registered a poll timer with 5000ms delay.
    expect(capturedTimers.length).toBeGreaterThanOrEqual(1);
    const pollTimer = capturedTimers[capturedTimers.length - 1];
    expect(pollTimer.delay).toBe(5000);

    // Fire the callback to simulate the 5-second tick.
    await tickPollTimers();

    // Allow the async fetch to resolve.
    await waitForEffects(50);

    const callsAfterInterval = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // At least one more call arrived after the retry tick.
    expect(callsAfterInterval).toBeGreaterThan(callsAfterImmediate);

    // The retry-triggered call(s) must carry statusOnly:true with no message.
    const retryCalls = fetchCalls
      .filter((c) => c.url === "/api/eliza-app/onboarding/chat")
      .slice(callsAfterImmediate);

    for (const call of retryCalls) {
      const body = call.body as Record<string, unknown>;
      expect(body.statusOnly).toBe(true);
      expect(body).not.toHaveProperty("message");
    }

    unmount();
  });

  test("repeated polls do not append duplicate assistant replies to the transcript", async () => {
    const { getState, unmount } = mountHook(
      true,
      "platform:blooio:+123****7890",
    );

    // Wait for mount + immediate poll.
    await waitForEffects(150);

    // Fire multiple timer ticks to simulate several 5-second polls.
    for (let i = 0; i < 3; i++) {
      await tickPollTimers();
      await waitForEffects(50);
    }

    // The transcript visible to the UI must not contain duplicate assistant
    // replies from poll turns. The backend's statusOnly guard means poll
    // responses carry one welcome message array; the hook's applyOnboardingResponse
    // replaces (not appends) the messages.
    const state = getState();
    const assistantMessages = state.messages.filter(
      (m) => m.role === "assistant",
    );
    expect(assistantMessages.length).toBeLessThanOrEqual(2);

    unmount();
  });

  test("shared onboarding replaces a ready target and clears a stale bridge", async () => {
    const { getState, unmount } = mountHook(
      true,
      "platform:blooio:+123****7890",
    );

    // Wait for mount + immediate poll (status pending).
    await waitForEffects(150);

    // Flip the mock so the next response is provisioning=running with a bridgeUrl.
    nextStatus = "running";

    // Fire the retry tick — the hook should see the first ready target but
    // keep its observation timer alive.
    await tickPollTimers();
    await waitForEffects(100);

    // The hook must have transitioned to ready.
    expect(getState().isReady).toBe(true);

    expect(getState().agentId).toBe("agent-123");
    expect(getState().bridgeUrl).toBe("https://agent-123.example");

    // The canonical session can move to a different running target while the
    // page stays mounted. Change the mock identity and observe another poll.
    runningAgentId = "agent-456";
    runningBridgeUrl = "https://agent-456.example";
    await tickPollTimers();
    await waitForEffects(50);

    expect(getState().agentId).toBe("agent-456");
    expect(getState().bridgeUrl).toBe("https://agent-456.example");

    nextStatus = "none";
    await tickPollTimers();
    await waitForEffects(50);

    expect(getState().containerStatus).toBe("none");
    expect(getState().agentId).toBeNull();
    expect(getState().bridgeUrl).toBeNull();
    expect(getState().isReady).toBe(false);
    expect([...activeTimers].filter((timer) => !timer.cleared)).toHaveLength(0);

    unmount();
  });

  test("legacy polling replaces a ready target and emits one ready receipt", async () => {
    nextStatus = "running";
    legacyStatusAgentId = "agent-a";
    legacyStatusBridgeUrl = "https://agent-a.example";
    const { getState, unmount } = mountHook(true, null);

    await waitForEffects(150);

    const readyCopy =
      "Your AI space is ready! You can start chatting in full now.";
    expect(getState().agentId).toBe("agent-a");
    expect(
      getState().messages.filter((message) => message.content === readyCopy),
    ).toHaveLength(1);

    legacyStatusAgentId = "agent-b";
    legacyStatusBridgeUrl = "https://agent-b.example";
    await tickPollTimers();
    await waitForEffects(50);

    expect(getState().agentId).toBe("agent-b");
    expect(getState().bridgeUrl).toBe("https://agent-b.example");
    expect(
      getState().messages.filter((message) => message.content === readyCopy),
    ).toHaveLength(1);

    nextStatus = "none";
    legacyStatusAgentId = null;
    legacyStatusBridgeUrl = null;
    await tickPollTimers();
    await waitForEffects(50);

    expect(getState().agentId).toBeNull();
    expect(getState().bridgeUrl).toBeNull();
    unmount();
  });

  test("concurrent legacy ready responses append one handoff receipt", async () => {
    nextStatus = "pending";
    let releaseBarrier: (() => void) | undefined;
    legacyStatusResponseBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const { getState, unmount } = mountHook(true, null);
    await waitForEffects(50);

    const firstPoll = fetchCalls.find(
      (call) => call.url === "/api/eliza-app/provisioning-agent",
    );
    expect(firstPoll).toBeDefined();
    const inFlight = capturedTimers[0]?.callback;
    expect(inFlight).toBeUndefined();

    nextStatus = "running";
    legacyStatusAgentId = "agent-a";
    legacyStatusBridgeUrl = "https://agent-a.example";
    releaseBarrier?.();
    await waitForEffects(150);

    const timer = [...activeTimers][0];
    expect(timer).toBeDefined();
    await Promise.all([timer.callback(), timer.callback()]);
    await waitForEffects(50);

    const readyCopy =
      "Your AI space is ready! You can start chatting in full now.";
    expect(
      getState().messages.filter((message) => message.content === readyCopy),
    ).toHaveLength(1);
    unmount();
  });

  test("cleanup on unmount stops the polling timer", async () => {
    const { unmount } = mountHook(true, "platform:blooio:+123****7890");

    // Wait for mount + immediate poll.
    await waitForEffects(150);

    const callsBefore = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // Verify a poll timer was active.
    expect(activeTimers.size).toBeGreaterThanOrEqual(1);

    unmount();

    // After unmount, all timers should be cleared.
    const activeAfterUnmount = [...activeTimers].filter((t) => !t.cleared);
    expect(activeAfterUnmount.length).toBe(0);

    // Fire timer ticks — since they are cleared, no calls should arrive.
    await tickPollTimers();
    await waitForEffects(50);

    const callsAfter = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // No new calls should have arrived after unmount.
    expect(callsAfter).toBe(callsBefore);
  });

  test("a terminal error status stops polling and surfaces provisioningError", async () => {
    nextStatus = "error";
    const { getState, unmount } = mountHook(
      true,
      "platform:blooio:+123****7890",
    );

    await waitForEffects(150);

    expect(getState().provisioningError).toContain("Provisioning failed");

    const callsBefore = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // Further timer ticks must not poll again after the terminal error.
    await tickPollTimers();
    await waitForEffects(50);

    const callsAfter = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;
    expect(callsAfter).toBe(callsBefore);

    unmount();
  });

  test("the poll deadline surfaces a timeout error instead of polling forever", async () => {
    const { getState, unmount } = mountHook(
      true,
      "platform:blooio:+123****7890",
    );

    await waitForEffects(150);
    expect(getState().provisioningError).toBeNull();

    const callsBefore = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // Advance past the 5-minute deadline without touching the wall clock.
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60 * 1000 + 1_000;
    try {
      await tickPollTimers();
      await waitForEffects(50);
    } finally {
      Date.now = realNow;
    }

    expect(getState().provisioningError).toContain("timed out");

    // Polling stops after the deadline fires: the tick above must not have
    // produced a network call, and further ticks stay silent.
    const callsAfterDeadline = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;
    expect(callsAfterDeadline).toBe(callsBefore);

    await tickPollTimers();
    await waitForEffects(50);
    const callsAfterExtraTick = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;
    expect(callsAfterExtraTick).toBe(callsBefore);

    unmount();
  });
});
