/**
 * Chat-surface coverage for the authenticated homepage provisioning hook.
 *
 * Companion to tests/provisioning-poll-hook.test.ts (which owns the poll
 * loop): this suite drives sendMessage, retryProvisioning, transcript
 * shaping, and session-reset behaviour through the real React DOM with a
 * mocked elizacloudAuthFetch transport under the repository's targeted
 * Vitest runner.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

const nativeSetTimeout = globalThis.setTimeout;

type Json = Record<string, unknown>;

const WELCOME_CONTENT =
  "Hi! I'm Eliza. I'll show your Cloud status here. Dedicated compute stays off until you explicitly start it.";
const READY_ANNOUNCEMENT =
  "Your AI space is ready! You can start chatting in full now.";
const CONNECTION_ERROR_CONTENT =
  "I'm having trouble connecting. Dedicated compute was not started or changed.";

const fetchCalls: Array<{ url: string; method: string; body: unknown }> = [];

// --- Configurable transport fixtures -------------------------------------
interface PollFixture {
  success?: boolean;
  status?: string;
  agentId?: string | null;
  bridgeUrl?: string | null;
  messages?: unknown;
}
let nextPoll: PollFixture;

let legacyStatus: {
  success: boolean;
  status?: string;
  agentId?: string | null;
  bridgeUrl?: string | null;
};

interface ChatFixture {
  behavior: "respond" | "reject" | "hold";
  payload?: Json;
}
let legacyChat: ChatFixture;
let sharedChat: { behavior: "respond" | "reject"; payload?: Json };

let releaseHeldChat: (() => void) | null = null;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null ? (value as Json) : null;
}

vi.mock("@/lib/api/client", () => ({
  elizacloudAuthFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const rawBody = init?.body as string | undefined;
    let parsedBody: unknown;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }
    fetchCalls.push({
      url,
      method: init?.method?.toUpperCase() ?? "GET",
      body: parsedBody,
    });

    if (url === "/api/eliza-app/provisioning-agent") {
      return {
        success: legacyStatus.success,
        data: {
          status: legacyStatus.status,
          agentId: legacyStatus.agentId ?? null,
          bridgeUrl: legacyStatus.bridgeUrl ?? null,
        },
      };
    }

    if (url === "/api/eliza-app/provisioning-agent/chat") {
      if (legacyChat.behavior === "hold") {
        await new Promise<void>((resolve) => {
          releaseHeldChat = resolve;
        });
      }
      if (legacyChat.behavior === "reject") {
        throw new Error("legacy chat transport failed");
      }
      return legacyChat.payload;
    }

    if (url === "/api/eliza-app/onboarding/chat") {
      const bodyObj = asObject(parsedBody);
      const isStatusOnly = bodyObj?.statusOnly === true;
      if (!isStatusOnly) {
        if (sharedChat.behavior === "reject") {
          throw new Error("shared chat transport failed");
        }
        return sharedChat.payload;
      }
      const data: Json = {
        provisioning: {
          status: nextPoll.status ?? null,
          agentId: nextPoll.agentId ?? null,
          bridgeUrl: nextPoll.bridgeUrl ?? null,
        },
      };
      if (nextPoll.messages !== undefined) {
        data.messages = nextPoll.messages;
      }
      return { success: nextPoll.success ?? true, data };
    }

    return { success: true, data: {} };
  }),
}));
vi.mock("@/lib/provisioning-poll-body", () =>
  import("../src/lib/provisioning-poll-body").then((m) => m),
);

const { useElizaAppProvisioningChat } = await import(
  "../src/lib/hooks/use-eliza-app-provisioning-chat"
);
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { JSDOM } = await import("jsdom");

// --- Controllable poll scheduler ------------------------------------------
interface CapturedTimer {
  callback: () => void;
  cleared: boolean;
  delay: number;
}
let capturedTimers: CapturedTimer[] = [];
let activeTimers: Set<CapturedTimer> = new Set();
let activeWindow: (Window & typeof globalThis) | null = null;
const domGlobalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "localStorage",
] as const;
const originalDomGlobals = new Map(
  domGlobalKeys.map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);

function setupDom() {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const g = globalThis as unknown as Record<string, unknown>;
  Object.defineProperties(g, {
    window: { configurable: true, writable: true, value: window },
    document: {
      configurable: true,
      writable: true,
      value: window.document,
    },
    navigator: {
      configurable: true,
      writable: true,
      value: window.navigator,
    },
    HTMLElement: {
      configurable: true,
      writable: true,
      value: window.HTMLElement,
    },
    localStorage: {
      configurable: true,
      writable: true,
      value: window.localStorage,
    },
  });

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

async function tickPollTimers() {
  const timers = [...activeTimers];
  for (const timer of timers) {
    if (!timer.cleared) {
      await timer.callback();
    }
  }
}

function waitForEffects(delay: number) {
  return new Promise<void>((resolve) => nativeSetTimeout(resolve, delay));
}

interface ObservedState {
  messages: Array<{ id: string; role: string; content: string }>;
  containerStatus: string;
  bridgeUrl: string | null;
  agentId: string | null;
  isLoading: boolean;
  isReady: boolean;
  isDedicatedOff: boolean;
  hasObservedStatus: boolean;
  provisioningError: string | null;
  sendMessage: (content: string) => Promise<void>;
  retryProvisioning: () => void;
}

function mountHook(
  active: boolean,
  sessionId: string | null,
): {
  getState: () => ObservedState;
  setProps: (next: { active?: boolean; sessionId?: string | null }) => void;
  unmount: () => void;
} {
  const window = (globalThis as unknown as { window: Window }).window;
  let state: ObservedState = {
    messages: [],
    containerStatus: "pending",
    bridgeUrl: null,
    agentId: null,
    isLoading: false,
    isReady: false,
    isDedicatedOff: false,
    hasObservedStatus: false,
    provisioningError: null,
    sendMessage: async () => undefined,
    retryProvisioning: () => undefined,
  };
  const props: { active: boolean; sessionId: string | null } = {
    active,
    sessionId,
  };

  function TestHarness() {
    const result = useElizaAppProvisioningChat(props.active, props.sessionId);
    React.useEffect(() => {
      state = {
        messages: result.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
        })),
        containerStatus: result.containerStatus,
        bridgeUrl: result.bridgeUrl,
        agentId: result.agentId,
        isLoading: result.isLoading,
        isReady: result.isReady,
        isDedicatedOff: result.isDedicatedOff,
        hasObservedStatus: result.hasObservedStatus,
        provisioningError: result.provisioningError,
        sendMessage: result.sendMessage,
        retryProvisioning: result.retryProvisioning,
      };
    });
    return React.createElement("div");
  }

  const container = window.document.getElementById("root");
  if (!container) throw new Error("root element not found");
  container.textContent = "";
  const root = createRoot(container);
  root.render(React.createElement(TestHarness));

  return {
    getState: () => state,
    setProps(next: { active?: boolean; sessionId?: string | null }) {
      Object.assign(props, next);
      root.render(React.createElement(TestHarness));
    },
    unmount: () => root.unmount(),
  };
}

function chatPosts(url: string) {
  return fetchCalls.filter(
    (call) => call.url === url && call.method === "POST",
  );
}

describe("useElizaAppProvisioningChat — chat surface, transcripts, lifecycle resets", () => {
  beforeEach(() => {
    setupDom();
    fetchCalls.length = 0;
    nextPoll = {
      success: true,
      status: "pending",
      agentId: null,
      bridgeUrl: null,
    };
    legacyStatus = { success: true, status: "pending" };
    legacyChat = {
      behavior: "respond",
      payload: {
        success: true,
        data: { reply: "legacy ack", containerStatus: "running" },
      },
    };
    sharedChat = {
      behavior: "respond",
      payload: { success: true, data: { reply: "shared ack" } },
    };
    releaseHeldChat = null;
    capturedTimers = [];
    activeTimers = new Set();
  });

  afterEach(() => {
    activeWindow?.close();
    activeWindow = null;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const g = globalThis as unknown as Record<string, unknown>;
    for (const key of domGlobalKeys) {
      const descriptor = originalDomGlobals.get(key);
      if (descriptor) {
        Object.defineProperty(g, key, descriptor);
      } else {
        delete g[key];
      }
    }
  });

  test("a successful poll that carries no transcript preserves exactly the welcome card", async () => {
    nextPoll = {
      success: true,
      status: "pending",
      agentId: null,
      bridgeUrl: null,
    };
    const { getState, unmount } = mountHook(true, "sess-welcome");

    await waitForEffects(150);

    expect(getState().messages).toEqual([
      { id: "welcome", role: "assistant", content: WELCOME_CONTENT },
    ]);
    expect(getState().containerStatus).toBe("pending");
    unmount();
  });

  test("the server transcript replaces welcome, drops invalid entries, and derives ids from createdAt plus surviving index", async () => {
    nextPoll = {
      success: true,
      status: "provisioning",
      agentId: null,
      bridgeUrl: null,
      messages: [
        { role: "system", content: "internal noise", createdAt: "c-system" },
        {
          role: "user",
          content: "hello there",
          createdAt: "2026-02-01T00:00:00Z",
        },
        { role: "assistant", content: "   ", createdAt: "c-blank" },
        { role: "assistant", content: 42, createdAt: "c-number" },
        { role: "assistant", content: "second valid", createdAt: undefined },
      ],
    };
    const { getState, unmount } = mountHook(true, "sess-shape");

    await waitForEffects(150);

    expect(getState().messages).toEqual([
      { id: "2026-02-01T00:00:00Z-0", role: "user", content: "hello there" },
      { id: "message-1", role: "assistant", content: "second valid" },
    ]);
    expect(getState().hasObservedStatus).toBe(true);
    unmount();
  });

  test("an empty server message queue resets the transcript back to the welcome card", async () => {
    nextPoll = {
      success: true,
      status: "pending",
      agentId: null,
      bridgeUrl: null,
      messages: [{ role: "user", content: "first turn", createdAt: "t0" }],
    };
    const { getState, unmount } = mountHook(true, "sess-empty");

    await waitForEffects(150);
    expect(getState().messages).toEqual([
      { id: "t0-0", role: "user", content: "first turn" },
    ]);

    nextPoll = { ...nextPoll, messages: [] };
    await tickPollTimers();
    await waitForEffects(80);

    expect(getState().messages).toEqual([
      { id: "welcome", role: "assistant", content: WELCOME_CONTENT },
    ]);
    unmount();
  });

  test("an inactive hook performs no requests, registers no timers, and exposes idle defaults", async () => {
    const { getState, unmount } = mountHook(false, "sess-idle");

    await waitForEffects(200);

    expect(fetchCalls).toHaveLength(0);
    expect([...activeTimers].filter((t) => !t.cleared)).toHaveLength(0);
    expect(getState().containerStatus).toBe("pending");
    expect(getState().isReady).toBe(false);
    expect(getState().isDedicatedOff).toBe(false);
    expect(getState().hasObservedStatus).toBe(false);
    expect(getState().provisioningError).toBeNull();
    expect(getState().messages).toEqual([
      { id: "welcome", role: "assistant", content: WELCOME_CONTENT },
    ]);
    unmount();
  });

  test("switching onboarding sessions clears every lifecycle value and repolls under the new session id", async () => {
    nextPoll = {
      success: true,
      status: "running",
      agentId: "agent-a",
      bridgeUrl: "https://agent-a.example",
      messages: [
        { role: "user", content: "session a turn", createdAt: "ta-0" },
      ],
    };
    const harness = mountHook(true, "session-a");
    await waitForEffects(150);
    expect(harness.getState().isReady).toBe(true);
    const callsBeforeSwitch = fetchCalls.length;

    nextPoll = {
      success: true,
      status: "pending",
      agentId: null,
      bridgeUrl: null,
    };
    harness.setProps({ sessionId: "session-b" });
    await waitForEffects(200);

    const state = harness.getState();
    expect(state.messages).toEqual([
      { id: "welcome", role: "assistant", content: WELCOME_CONTENT },
    ]);
    expect(state.agentId).toBeNull();
    expect(state.bridgeUrl).toBeNull();
    expect(state.isReady).toBe(false);
    expect(state.provisioningError).toBeNull();

    const onboardingBodies = fetchCalls
      .filter((call) => call.url === "/api/eliza-app/onboarding/chat")
      .map((call) => asObject(call.body));
    const firstSessionBIndex = onboardingBodies.findIndex(
      (body) => body?.sessionId === "session-b",
    );
    expect(firstSessionBIndex).toBeGreaterThan(-1);
    expect(
      onboardingBodies
        .slice(firstSessionBIndex)
        .every((b) => b?.sessionId === "session-b"),
    ).toBe(true);
    expect(fetchCalls.length).toBeGreaterThan(callsBeforeSwitch);
    harness.unmount();
  });

  test("whitespace-only input is rejected locally with no request and no transcript change", async () => {
    legacyStatus = {
      success: true,
      status: "running",
      agentId: "agent-a",
      bridgeUrl: "https://agent-a.example",
    };
    const { getState, unmount } = mountHook(true, null);
    await waitForEffects(150);
    expect(getState().isReady).toBe(true);
    const lengthBefore = getState().messages.length;

    await getState().sendMessage("   ");
    await waitForEffects(50);

    expect(getState().messages).toHaveLength(lengthBefore);
    expect(chatPosts("/api/eliza-app/provisioning-agent/chat")).toHaveLength(0);
    expect(chatPosts("/api/eliza-app/onboarding/chat")).toHaveLength(0);
    unmount();
  });

  test("legacy chat posts the trimmed message plus current canonical agentId and appends both turns", async () => {
    legacyStatus = {
      success: true,
      status: "running",
      agentId: "agent-a",
      bridgeUrl: "https://agent-a.example",
    };
    const { getState, unmount } = mountHook(true, null);
    await waitForEffects(150);

    legacyChat = {
      behavior: "respond",
      payload: {
        success: true,
        data: {
          reply: "Canonical target refreshed.",
          containerStatus: "running",
          agentId: "agent-a",
          bridgeUrl: "https://agent-a.example",
        },
      },
    };
    await getState().sendMessage("  hello agent  ");
    await waitForEffects(80);

    const posts = chatPosts("/api/eliza-app/provisioning-agent/chat");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      message: "hello agent",
      agentId: "agent-a",
    });
    expect(getState().bridgeUrl).toBe("https://agent-a.example");

    const messages = getState().messages;
    expect(messages[messages.length - 2]).toEqual({
      id: expect.any(String),
      role: "user",
      content: "hello agent",
    });
    expect(messages[messages.length - 1]).toEqual({
      id: expect.any(String),
      role: "assistant",
      content: "Canonical target refreshed.",
    });
    expect(getState().isLoading).toBe(false);
    unmount();
  });

  test("an in-flight legacy chat reports isLoading, blocks concurrent sends, and yields one exchange", async () => {
    legacyStatus = {
      success: true,
      status: "running",
      agentId: "agent-a",
      bridgeUrl: "https://agent-a.example",
    };
    const { getState, unmount } = mountHook(true, null);
    await waitForEffects(150);

    legacyChat = {
      behavior: "hold",
      payload: {
        success: true,
        data: { reply: "late reply", containerStatus: "running" },
      },
    };

    const first = getState().sendMessage("first");
    await waitForEffects(120);
    expect(getState().isLoading).toBe(true);

    await getState().sendMessage("second");
    releaseHeldChat?.();
    await first;
    await waitForEffects(80);

    const posts = chatPosts("/api/eliza-app/provisioning-agent/chat");
    expect(posts).toHaveLength(1);
    const userTurns = getState().messages.filter((m) => m.role === "user");
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0].content).toBe("first");
    expect(getState().messages[getState().messages.length - 1].content).toBe(
      "late reply",
    );
    expect(getState().isLoading).toBe(false);
    unmount();
  });

  test("a rejected legacy chat appends the connection-error assistant turn and clears isLoading", async () => {
    legacyStatus = {
      success: true,
      status: "running",
      agentId: "agent-a",
      bridgeUrl: "https://agent-a.example",
    };
    const { getState, unmount } = mountHook(true, null);
    await waitForEffects(150);

    legacyChat = { behavior: "reject" };
    await getState().sendMessage("you there?");
    await waitForEffects(80);

    const messages = getState().messages;
    expect(messages[messages.length - 2].role).toBe("user");
    expect(messages[messages.length - 1]).toEqual({
      id: expect.any(String),
      role: "assistant",
      content: CONNECTION_ERROR_CONTENT,
    });
    expect(getState().isLoading).toBe(false);
    unmount();
  });

  test("a success:false legacy chat leaves only the user turn and never fabricates an assistant reply", async () => {
    legacyStatus = {
      success: true,
      status: "running",
      agentId: "agent-a",
      bridgeUrl: "https://agent-a.example",
    };
    const { getState, unmount } = mountHook(true, null);
    await waitForEffects(150);

    legacyChat = { behavior: "respond", payload: { success: false } };
    const lengthBefore = getState().messages.length;
    await getState().sendMessage("still there?");
    await waitForEffects(80);

    const messages = getState().messages;
    expect(messages).toHaveLength(lengthBefore + 1);
    expect(messages[messages.length - 1].role).toBe("user");
    expect(getState().isLoading).toBe(false);
    unmount();
  });

  test("shared chat posts the exact session contract with platform blooio and no statusOnly field", async () => {
    nextPoll = {
      success: true,
      status: "running",
      agentId: "agent-x",
      bridgeUrl: "https://x.example",
    };
    sharedChat = {
      behavior: "respond",
      payload: { success: true, data: { reply: "hi!" } },
    };
    const { getState, unmount } = mountHook(true, "sess-post");
    await waitForEffects(150);
    expect(getState().isReady).toBe(true);

    await getState().sendMessage("make it mine");
    await waitForEffects(80);

    const chats = fetchCalls.filter(
      (call) =>
        call.url === "/api/eliza-app/onboarding/chat" &&
        asObject(call.body)?.message !== undefined,
    );
    expect(chats).toHaveLength(1);
    const body = asObject(chats[0].body);
    expect(body?.sessionId).toBe("sess-post");
    expect(body?.message).toBe("make it mine");
    expect(body?.platform).toBe("blooio");
    expect(Object.keys(body).sort()).toEqual([
      "message",
      "platform",
      "sessionId",
    ]);
    unmount();
  });

  test("shared chat response applies authoritative replacement and clears a stale bridge when status leaves running", async () => {
    nextPoll = {
      success: true,
      status: "running",
      agentId: "agent-a",
      bridgeUrl: "https://a.example",
    };
    const { getState, unmount } = mountHook(true, "sess-authority");
    await waitForEffects(150);
    expect(getState().bridgeUrl).toBe("https://a.example");

    sharedChat = {
      behavior: "respond",
      payload: {
        success: true,
        data: {
          provisioning: {
            status: "stopped",
            agentId: "agent-b",
            bridgeUrl: "https://stale.example",
          },
          messages: [
            { role: "assistant", content: "target replaced", createdAt: "r0" },
          ],
        },
      },
    };
    await getState().sendMessage("refresh");
    await waitForEffects(80);

    expect(getState().containerStatus).toBe("stopped");
    expect(getState().agentId).toBe("agent-b");
    expect(getState().bridgeUrl).toBeNull();
    expect(getState().isReady).toBe(false);
    expect(getState().messages).toEqual([
      { id: "r0-0", role: "assistant", content: "target replaced" },
    ]);
    unmount();
  });

  test("repeated running polls append the ready announcement exactly once", async () => {
    legacyStatus = {
      success: true,
      status: "running",
      agentId: "agent-a",
      bridgeUrl: "https://agent-a.example",
    };
    const { getState, unmount } = mountHook(true, null);
    await waitForEffects(150);

    for (let i = 0; i < 3; i++) {
      await tickPollTimers();
      await waitForEffects(60);
    }

    const announcements = getState().messages.filter((m) =>
      m.content.includes(READY_ANNOUNCEMENT),
    );
    expect(announcements).toHaveLength(1);
    expect(getState().isReady).toBe(true);
    unmount();
  });

  test("a mid-stream none poll stops the loop permanently instead of polling forever", async () => {
    legacyStatus = {
      success: true,
      status: "running",
      agentId: "agent-a",
      bridgeUrl: "https://agent-a.example",
    };
    const { getState, unmount } = mountHook(true, null);
    await waitForEffects(150);
    expect(getState().isReady).toBe(true);

    legacyStatus = { success: true, status: "none" };
    await tickPollTimers();
    await waitForEffects(80);

    expect(getState().containerStatus).toBe("none");
    expect(getState().isDedicatedOff).toBe(true);

    const statusGetsBeforeIdle = fetchCalls.filter(
      (call) => call.url === "/api/eliza-app/provisioning-agent",
    ).length;
    await tickPollTimers();
    await waitForEffects(80);
    const statusGetsAfterIdle = fetchCalls.filter(
      (call) => call.url === "/api/eliza-app/provisioning-agent",
    ).length;
    expect(statusGetsAfterIdle).toBe(statusGetsBeforeIdle);
    unmount();
  });

  test("retryProvisioning clears the timeout error and resumes polling", async () => {
    nextPoll = {
      success: true,
      status: "provisioning",
      agentId: null,
      bridgeUrl: null,
    };
    const { getState, unmount } = mountHook(true, "sess-retry");
    await waitForEffects(150);
    expect(getState().provisioningError).toBeNull();

    const callsBeforeDeadline = fetchCalls.filter(
      (call) => call.url === "/api/eliza-app/onboarding/chat",
    ).length;

    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60 * 1000 + 1_000;
    try {
      await tickPollTimers();
      await waitForEffects(60);
    } finally {
      Date.now = realNow;
    }
    expect(getState().provisioningError).toContain("timed out");
    const callsAfterDeadline = fetchCalls.filter(
      (call) => call.url === "/api/eliza-app/onboarding/chat",
    ).length;
    expect(callsAfterDeadline).toBe(callsBeforeDeadline);

    getState().retryProvisioning();
    await waitForEffects(250);

    expect(getState().provisioningError).toBeNull();
    const callsAfterRetry = fetchCalls.filter(
      (call) => call.url === "/api/eliza-app/onboarding/chat",
    ).length;
    expect(callsAfterRetry).toBeGreaterThan(callsAfterDeadline);
    unmount();
  });

  test("poll timers are registered with the production five-second interval", async () => {
    const { unmount } = mountHook(true, "sess-interval");
    await waitForEffects(150);

    expect(capturedTimers.length).toBeGreaterThanOrEqual(1);
    expect(capturedTimers[capturedTimers.length - 1].delay).toBe(5000);
    unmount();
  });
});
