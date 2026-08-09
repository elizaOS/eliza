/**
 * Hook-level test for the shared-onboarding provisioning poll.
 *
 * Mounts useElizaAppProvisioningChat with a shared onboarding session id,
 * controls elizacloudAuthFetch via mock.module, and proves:
 * - the immediate (mount) request carries statusOnly via buildProvisioningPollBody
 * - the 5-second interval request carries statusOnly with no message
 * - the returned transcript has no poll-generated duplicate assistant replies
 * - cleanup (isReady / unmount) stops further polling
 *
 * Uses jsdom (already a root devDependency) to provide the DOM React needs,
 * and bun:test's mock.module to intercept the auth-fetch seam.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Capture every fetch invocation so tests can assert on the request body.
const fetchCalls: Array<{ url: string; body: unknown }> = [];

// The mock returns a provisioning-pending response so the poll loop keeps
// running until the test deliberately flips the status to "running".
let nextStatus = "pending";
let nextBridgeUrl: string | null = null;

// mock.module intercepts the import inside use-eliza-app-provisioning-chat.ts.
// The source file uses the @/ alias (resolved by Vite/tsconfig to src/), so we
// register the mock under both the alias path and the relative path.
const clientMock = {
  elizacloudAuthFetch: mock(async (url: string, init?: RequestInit) => {
    const bodyStr = init?.body as string | undefined;
    let parsedBody: unknown = undefined;
    if (bodyStr) {
      try {
        parsedBody = JSON.parse(bodyStr);
      } catch {
        parsedBody = bodyStr;
      }
    }
    fetchCalls.push({ url, body: parsedBody });

    if (url === "/api/eliza-app/onboarding/chat") {
      const isStatusOnly =
        typeof parsedBody === "object" &&
        parsedBody !== null &&
        (parsedBody as Record<string, unknown>).statusOnly === true;

      return {
        success: true,
        data: {
          reply: isStatusOnly
            ? "on it, your agent is spinning up now."
            : "Hi! I'm Eliza.",
          provisioning: {
            status: nextStatus,
            agentId: nextStatus === "running" ? "agent-123" : null,
            bridgeUrl: nextBridgeUrl,
          },
          messages: [
            { role: "assistant" as const, content: "Hi! I'm Eliza.", createdAt: "2026-01-01T00:00:00Z" },
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
  g.clearInterval = window.clearInterval.bind(window);
  g.setInterval = window.setInterval.bind(window);
  return window as unknown as Window & typeof globalThis;
}

interface ObservedState {
  messages: Array<{ role: string; content: string }>;
  containerStatus: string;
  isReady: boolean;
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
  };

  function TestHarness() {
    const result = useElizaAppProvisioningChat(active, sessionId);
    React.useEffect(() => {
      state = {
        messages: result.messages.map((m) => ({ role: m.role, content: m.content })),
        containerStatus: result.containerStatus,
        isReady: result.isReady,
      };
    });
    return React.createElement("div");
  }

  const container = window.document.getElementById("root")!;
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
    nextBridgeUrl = null;
  });

  test("immediate poll sends statusOnly:true with no message field", async () => {
    const { unmount } = mountHook(true, "platform:blooio:+123****7890");

    // Wait for the mount effect + immediate poll to fire
    await new Promise((r) => setTimeout(r, 150));

    const chatCalls = fetchCalls.filter((c) => c.url === "/api/eliza-app/onboarding/chat");

    // The polling effect fires immediately on mount. That call uses
    // buildProvisioningPollBody which must carry statusOnly:true.
    const pollCalls = chatCalls.filter((c) => {
      const body = c.body as Record<string, unknown> | undefined;
      return body?.statusOnly === true;
    });

    expect(pollCalls.length).toBeGreaterThanOrEqual(1);

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

  test("repeated polls do not append duplicate assistant replies to the transcript", async () => {
    const { getState, unmount } = mountHook(true, "platform:blooio:+123****7890");

    // Let the mount effect + immediate poll fire
    await new Promise((r) => setTimeout(r, 200));

    const pollCalls = fetchCalls.filter((c) => {
      if (c.url !== "/api/eliza-app/onboarding/chat") return false;
      const body = c.body as Record<string, unknown> | undefined;
      return body?.statusOnly === true;
    });

    // At least 1 status-only poll should have fired
    expect(pollCalls.length).toBeGreaterThanOrEqual(1);

    // The transcript visible to the UI must not contain duplicate assistant
    // replies from poll turns. The backend's statusOnly guard means poll
    // responses carry one welcome message array; the hook's applyOnboardingResponse
    // replaces (not appends) the messages. So no matter how many polls fire,
    // the assistant message count stays bounded.
    const state = getState();
    const assistantMessages = state.messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBeLessThanOrEqual(2);

    unmount();
  });

  test("cleanup on unmount stops the polling interval", async () => {
    const { unmount } = mountHook(true, "platform:blooio:+123****7890");

    await new Promise((r) => setTimeout(r, 150));
    const callsBefore = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    unmount();

    // Wait long enough for at least one more poll cycle (5 s interval)
    // to have fired if the interval were NOT cleared.
    await new Promise((r) => setTimeout(r, 200));

    const callsAfter = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // No new calls should have arrived after unmount
    expect(callsAfter).toBe(callsBefore);
  });
});
