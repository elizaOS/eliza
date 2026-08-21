/**
 * Behaviour coverage for the policy-controlled browser session panel under
 * jsdom with a protocol-faithful in-memory transport (the fake keeps real
 * session/settings state and applies confirm/settings writes the way the
 * bridge routes do). Verifies the three distinct load states, takeover
 * confirm/decline, domain grant/block writes, submit interception surfacing,
 * receipt redaction, and the action-error banner on a failed write.
 */
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  BrowserBridgeSettings,
  UpdateBrowserBridgeSettingsRequest,
} from "../../api/browser-contracts";
import type { BrowserBridgeSession } from "../../api/client-browser-bridge";
import type { BrowserSessionPolicyApi } from "./BrowserSessionPolicyPanel";
import { BrowserSessionPolicyPanel } from "./BrowserSessionPolicyPanel";

const NOW_SETTINGS: BrowserBridgeSettings = {
  enabled: true,
  trackingMode: "active_tabs",
  allowBrowserControl: true,
  requireConfirmationForAccountAffecting: true,
  incognitoEnabled: false,
  siteAccessMode: "granted_sites",
  grantedOrigins: ["docs.example.com"],
  blockedOrigins: ["trading.example.com"],
  maxRememberedTabs: 8,
  pauseUntil: null,
  metadata: {},
  updatedAt: "2026-08-20T11:00:00.000Z",
};

function makeSession(
  overrides: Partial<BrowserBridgeSession> = {},
): BrowserBridgeSession {
  return {
    id: "s-1",
    agentId: "agent-1",
    domain: "docs.example.com",
    workflowId: null,
    browser: "chrome",
    companionId: "c-1",
    profileId: "default",
    windowId: "w-1",
    tabId: "t-1",
    title: "Summarize the docs page",
    status: "running",
    actions: [],
    currentActionIndex: 0,
    awaitingConfirmationForActionId: null,
    result: {},
    metadata: {},
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T11:30:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

/**
 * In-memory transport that mirrors the bridge route semantics: confirm flips
 * an awaiting session to queued (true) or cancelled (false); settings writes
 * merge the patch and bump updatedAt.
 */
function makeFakeApi(
  sessions: BrowserBridgeSession[],
  settings: BrowserBridgeSettings = NOW_SETTINGS,
) {
  const state = {
    sessions: sessions.map((s) => ({ ...s })),
    settings: { ...settings },
    settingsWrites: [] as UpdateBrowserBridgeSettingsRequest[],
    confirmCalls: [] as Array<{ id: string; confirmed: boolean }>,
  };
  const api: BrowserSessionPolicyApi = {
    async listBrowserBridgeSessions() {
      return { sessions: state.sessions.map((s) => ({ ...s })) };
    },
    async getBrowserBridgeSettings() {
      return { settings: { ...state.settings } };
    },
    async updateBrowserBridgeSettings(request) {
      state.settingsWrites.push(request);
      state.settings = {
        ...state.settings,
        ...request,
        updatedAt: "2026-08-20T11:45:00.000Z",
      } as BrowserBridgeSettings;
      return { settings: { ...state.settings } };
    },
    async confirmBrowserBridgeSession(id, confirmed) {
      state.confirmCalls.push({ id, confirmed });
      const existing = state.sessions.find((s) => s.id === id);
      if (!existing) {
        throw new Error(`Browser session not found: ${id}`);
      }
      existing.status = confirmed ? "queued" : "cancelled";
      existing.awaitingConfirmationForActionId = null;
      return { session: { ...existing } };
    },
  };
  return { api, state };
}

describe("BrowserSessionPolicyPanel", () => {
  it("shows the loading state, then the designed-empty state", async () => {
    const { api } = makeFakeApi([]);
    render(<BrowserSessionPolicyPanel api={api} />);
    expect(screen.getByTestId("browser-session-policy-loading")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("browser-session-policy-empty")).toBeTruthy(),
    );
  });

  it("shows a distinct error state with retry when loading fails", async () => {
    const { api } = makeFakeApi([makeSession()]);
    let fail = true;
    const flaky: BrowserSessionPolicyApi = {
      ...api,
      async listBrowserBridgeSessions() {
        if (fail) throw new Error("bridge offline");
        return api.listBrowserBridgeSessions();
      },
    };
    render(<BrowserSessionPolicyPanel api={flaky} />);
    await waitFor(() =>
      expect(screen.getByTestId("browser-session-policy-error")).toBeTruthy(),
    );
    expect(screen.getByText("bridge offline")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByTestId("browser-session-policy-panel")).toBeTruthy(),
    );
  });

  it("renders policy verdicts per session domain", async () => {
    const { api } = makeFakeApi([
      makeSession({ id: "s-granted", domain: "docs.example.com" }),
      makeSession({ id: "s-blocked", domain: "trading.example.com" }),
      makeSession({ id: "s-outside", domain: "social.example.net" }),
    ]);
    render(<BrowserSessionPolicyPanel api={api} />);
    await waitFor(() =>
      expect(screen.getByTestId("browser-session-policy-panel")).toBeTruthy(),
    );
    expect(
      screen.getByTestId("browser-session-s-granted-policy").textContent,
    ).toBe("Granted");
    expect(
      screen.getByTestId("browser-session-s-blocked-policy").textContent,
    ).toBe("Blocked");
    expect(
      screen.getByTestId("browser-session-s-outside-policy").textContent,
    ).toBe("Not granted");
  });

  it("approves a takeover session through the confirm route", async () => {
    const { api, state } = makeFakeApi([
      makeSession({
        id: "s-takeover",
        status: "awaiting_confirmation",
        awaitingConfirmationForActionId: "a-1",
      }),
    ]);
    render(<BrowserSessionPolicyPanel api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("browser-session-s-takeover-approve"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("browser-session-s-takeover-approve"));
    await waitFor(() =>
      expect(
        screen.getByTestId("browser-session-s-takeover-status").textContent,
      ).toBe("Queued"),
    );
    expect(state.confirmCalls).toEqual([{ id: "s-takeover", confirmed: true }]);
  });

  it("declines a takeover session, cancelling it", async () => {
    const { api, state } = makeFakeApi([
      makeSession({ id: "s-decline", status: "awaiting_confirmation" }),
    ]);
    render(<BrowserSessionPolicyPanel api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("browser-session-s-decline-decline"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("browser-session-s-decline-decline"));
    await waitFor(() =>
      expect(
        screen.getByTestId("browser-session-s-decline-status").textContent,
      ).toBe("Cancelled"),
    );
    expect(state.confirmCalls).toEqual([{ id: "s-decline", confirmed: false }]);
  });

  it("grants and blocks a domain through the settings route", async () => {
    const { api, state } = makeFakeApi([
      makeSession({ id: "s-grantable", domain: "social.example.net" }),
    ]);
    render(<BrowserSessionPolicyPanel api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("browser-session-s-grantable-grant"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("browser-session-s-grantable-grant"));
    await waitFor(() =>
      expect(
        screen.getByTestId("browser-session-s-grantable-policy").textContent,
      ).toBe("Granted"),
    );
    expect(state.settingsWrites[0]?.grantedOrigins).toContain(
      "social.example.net",
    );
    fireEvent.click(screen.getByTestId("browser-session-s-grantable-block"));
    await waitFor(() =>
      expect(
        screen.getByTestId("browser-session-s-grantable-policy").textContent,
      ).toBe("Blocked"),
    );
    expect(state.settingsWrites[1]?.blockedOrigins).toContain(
      "social.example.net",
    );
  });

  it("surfaces intercepted submit steps and a redacted receipt", async () => {
    const { api } = makeFakeApi([
      makeSession({
        id: "s-receipt",
        status: "done",
        finishedAt: "2026-08-20T11:40:00.000Z",
        actions: [
          {
            id: "a-submit",
            kind: "submit",
            label: "Submit checkout",
            url: null,
            selector: "#checkout",
            text: null,
            accountAffecting: false,
            requiresConfirmation: false,
            metadata: {},
          },
        ],
        result: { orderId: "ORD-9", accessToken: "sk-live-nope" },
      }),
    ]);
    render(<BrowserSessionPolicyPanel api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("browser-session-s-receipt-receipt"),
      ).toBeTruthy(),
    );
    expect(
      screen.getByTestId("browser-session-s-receipt-intercepted").textContent,
    ).toContain("Submit checkout");
    const receipt = screen.getByTestId("browser-session-s-receipt-receipt");
    expect(receipt.textContent).toContain("ORD-9");
    expect(receipt.textContent).toContain("[redacted]");
    expect(receipt.textContent).not.toContain("sk-live-nope");
  });

  it("shows the action-error banner when a policy write fails", async () => {
    const { api } = makeFakeApi([
      makeSession({ id: "s-fail", domain: "social.example.net" }),
    ]);
    const failing: BrowserSessionPolicyApi = {
      ...api,
      async updateBrowserBridgeSettings() {
        throw new Error("settings write rejected");
      },
    };
    render(<BrowserSessionPolicyPanel api={failing} />);
    await waitFor(() =>
      expect(screen.getByTestId("browser-session-s-fail-block")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("browser-session-s-fail-block"));
    await waitFor(() =>
      expect(
        screen.getByTestId("browser-session-policy-action-error").textContent,
      ).toBe("settings write rejected"),
    );
  });
});
