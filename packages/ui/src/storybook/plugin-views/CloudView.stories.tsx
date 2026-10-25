/**
 * Renders the shipped Cloud account view through its injected fetch boundary.
 * Offline fixtures expose account, section-error, and recovery states without
 * connecting an account or opening a billing destination.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { CloudPage } from "../../../../../plugins/plugin-elizacloud/src/components/cloud/CloudPage";
import type { CloudViewFetchers } from "../../../../../plugins/plugin-elizacloud/src/components/cloud/CloudView";

const connected = {
  connected: true,
  enabled: true,
  hasApiKey: true,
  userId: "story-user",
  organizationId: "story-org",
};
const fetchers: CloudViewFetchers = {
  fetchStatus: async () => connected,
  fetchCredits: async () => ({
    connected: true,
    balance: 12.34,
    low: false,
    critical: false,
    topUpUrl: "https://cloud.eliza.app/cloud/billing",
  }),
  fetchAgents: async () => ({ success: true, data: [] }),
  fetchApiKeys: async () => ({
    keys: [],
    manageUrl: "https://cloud.eliza.app/cloud/api-keys",
  }),
  fetchBillingSummary: async () => ({
    balance: 12.34,
    currency: "USD",
    hasPaymentMethod: false,
  }),
};
const meta = {
  title: "Plugin views/Cloud",
  component: CloudPage,
  args: {
    fetchers,
    interactions: {
      navigateInternal: fn(),
      openExternal: fn(async () => false),
    },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CloudPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EmptyAccount: Story = {};
export const Loading: Story = {
  args: { fetchers: { ...fetchers, fetchStatus: () => new Promise(() => {}) } },
};
export const SignedOut: Story = {
  args: {
    fetchers: {
      ...fetchers,
      fetchStatus: async () => ({
        ...connected,
        connected: false,
        hasApiKey: false,
      }),
    },
  },
};
export const LoadError: Story = {
  args: {
    fetchers: {
      ...fetchers,
      fetchStatus: async () => {
        throw new Error("Account connection is unavailable");
      },
    },
  },
};
export const SectionsUnavailable: Story = {
  args: {
    fetchers: {
      ...fetchers,
      fetchCredits: async () => {
        throw new Error("Credits unavailable");
      },
      fetchAgents: async () => ({
        success: false,
        data: [],
        error: "Hosted agents unavailable",
      }),
      fetchApiKeys: async () => {
        throw new Error("API keys unavailable");
      },
      fetchBillingSummary: async () => {
        throw new Error("Billing unavailable");
      },
    },
  },
};
export const Populated: Story = {
  args: {
    fetchers: {
      ...fetchers,
      fetchAgents: async () => ({
        success: true,
        data: [
          {
            agent_id: "story-agent",
            agent_name: "Planning assistant",
            node_id: null,
            container_id: null,
            headscale_ip: null,
            bridge_url: null,
            web_ui_url: null,
            status: "running",
            agent_config: {},
            created_at: "2026-09-01T12:00:00Z",
            updated_at: "2026-09-01T12:00:00Z",
            containerUrl: "",
            webUiUrl: null,
            database_status: "healthy",
            error_message: null,
            last_heartbeat_at: null,
          },
        ],
      }),
      fetchApiKeys: async () => ({
        keys: [
          {
            id: "story-key",
            name: "Development",
            keyPrefix: "eliza_preview",
            createdAt: null,
          },
        ],
        manageUrl: "https://cloud.eliza.app/cloud/api-keys",
      }),
    },
  },
};
