/**
 * Storybook stories for the policy-controlled browser session panel: the
 * empty, error, takeover, blocked-domain, and finished-with-receipt states,
 * each backed by a deterministic in-memory transport fake.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type { BrowserBridgeSettings } from "../../api/browser-contracts";
import type { BrowserBridgeSession } from "../../api/client-browser-bridge";
import type { BrowserSessionPolicyApi } from "./BrowserSessionPolicyPanel";
import { BrowserSessionPolicyPanel } from "./BrowserSessionPolicyPanel";

const SETTINGS: BrowserBridgeSettings = {
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
  overrides: Partial<BrowserBridgeSession>,
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

function staticApi(sessions: BrowserBridgeSession[]): BrowserSessionPolicyApi {
  let settings = { ...SETTINGS };
  const state = sessions.map((s) => ({ ...s }));
  return {
    async listBrowserBridgeSessions() {
      return { sessions: state.map((s) => ({ ...s })) };
    },
    async getBrowserBridgeSettings() {
      return { settings: { ...settings } };
    },
    async updateBrowserBridgeSettings(request) {
      settings = { ...settings, ...request } as BrowserBridgeSettings;
      return { settings: { ...settings } };
    },
    async confirmBrowserBridgeSession(id, confirmed) {
      const existing = state.find((s) => s.id === id);
      if (!existing) throw new Error(`Browser session not found: ${id}`);
      existing.status = confirmed ? "queued" : "cancelled";
      return { session: { ...existing } };
    },
  };
}

const failingApi: BrowserSessionPolicyApi = {
  async listBrowserBridgeSessions() {
    throw new Error("bridge offline");
  },
  async getBrowserBridgeSettings() {
    throw new Error("bridge offline");
  },
  async updateBrowserBridgeSettings() {
    throw new Error("bridge offline");
  },
  async confirmBrowserBridgeSession() {
    throw new Error("bridge offline");
  },
};

const meta: Meta<typeof BrowserSessionPolicyPanel> = {
  title: "Browser/BrowserSessionPolicyPanel",
  component: BrowserSessionPolicyPanel,
};
export default meta;

type Story = StoryObj<typeof BrowserSessionPolicyPanel>;

export const Empty: Story = {
  args: { api: staticApi([]) },
};

export const LoadError: Story = {
  args: { api: failingApi },
};

export const AwaitingTakeover: Story = {
  args: {
    api: staticApi([
      makeSession({
        id: "s-takeover",
        status: "awaiting_confirmation",
        awaitingConfirmationForActionId: "a-1",
        actions: [
          {
            id: "a-1",
            kind: "submit",
            label: "Submit reservation",
            url: null,
            selector: "#reserve",
            text: null,
            accountAffecting: true,
            requiresConfirmation: true,
            metadata: {},
          },
        ],
      }),
    ]),
  },
};

export const BlockedAndOutsideGrants: Story = {
  args: {
    api: staticApi([
      makeSession({
        id: "s-blocked",
        domain: "trading.example.com",
        title: "Place a trade",
        status: "failed",
        finishedAt: "2026-08-20T11:35:00.000Z",
        result: { reason: "domain blocked by policy" },
      }),
      makeSession({
        id: "s-outside",
        domain: "social.example.net",
        title: "Post an update",
      }),
    ]),
  },
};

export const FinishedWithReceipt: Story = {
  args: {
    api: staticApi([
      makeSession({
        id: "s-done",
        status: "done",
        finishedAt: "2026-08-20T11:40:00.000Z",
        result: {
          summary: "Copied the release notes into a draft.",
          pagesVisited: 3,
          accessToken: "never-shown",
        },
      }),
    ]),
  },
};
