import type { Meta, StoryObj } from "@storybook/react";
import type { AccountWithCredentialFlag } from "../../api/client-agent";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { AccountCard } from "./AccountCard";

const mockAppContext = new Proxy({} as AppContextValue, {
  get(_, prop) {
    if (prop === "t") {
      return (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? "";
    }
    if (prop === "uiLanguage") return "en";
    if (prop === "companionHalfFramerateMode") return "when_saving_power";
    if (prop === "navigation") {
      return {
        scheduleAfterTabCommit: (fn: () => void) => {
          queueMicrotask(fn);
        },
      };
    }
    return () => {};
  },
});

const baseAccount: AccountWithCredentialFlag = {
  id: "acct_anthropic_primary",
  providerId: "anthropic-subscription",
  label: "Anthropic — primary",
  source: "oauth",
  enabled: true,
  priority: 1,
  createdAt: Date.now() - 1000 * 60 * 60 * 24 * 7,
  lastUsedAt: Date.now() - 1000 * 60 * 12,
  health: "ok",
  usage: {
    sessionPct: 42,
    weeklyPct: 18,
    resetsAt: Date.now() + 1000 * 60 * 60 * 3,
    refreshedAt: Date.now() - 1000 * 60 * 5,
  },
  hasCredential: true,
};

const meta = {
  title: "Accounts/AccountCard",
  component: AccountCard,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <AppContext.Provider value={mockAppContext}>
        <div className="max-w-3xl p-6">
          <Story />
        </div>
      </AppContext.Provider>
    ),
  ],
  argTypes: {
    isFirst: { control: "boolean" },
    isLast: { control: "boolean" },
    saving: { control: "boolean" },
    testBusy: { control: "boolean" },
    refreshBusy: { control: "boolean" },
  },
  args: {
    account: baseAccount,
    isFirst: false,
    isLast: false,
    saving: false,
    testBusy: false,
    refreshBusy: false,
    onPatch: async () => {},
    onMoveUp: async () => {},
    onMoveDown: async () => {},
    onTest: async () => {},
    onRefreshUsage: async () => {},
    onDelete: async () => {},
  },
} satisfies Meta<typeof AccountCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const HighUsageWarning: Story = {
  args: {
    account: {
      ...baseAccount,
      label: "Anthropic — heavy use",
      usage: {
        sessionPct: 72,
        weeklyPct: 64,
        resetsAt: Date.now() + 1000 * 60 * 45,
        refreshedAt: Date.now() - 1000 * 60,
      },
    },
  },
};

export const RateLimited: Story = {
  args: {
    account: {
      ...baseAccount,
      label: "Anthropic — capped",
      health: "rate-limited",
      healthDetail: { until: Date.now() + 1000 * 60 * 90 },
      usage: {
        sessionPct: 98,
        weeklyPct: 91,
        resetsAt: Date.now() + 1000 * 60 * 90,
        refreshedAt: Date.now() - 1000 * 30,
      },
    },
  },
};

export const NeedsReauth: Story = {
  args: {
    account: {
      ...baseAccount,
      id: "acct_codex_main",
      providerId: "openai-codex",
      label: "Codex — main",
      source: "oauth",
      health: "needs-reauth",
      usage: { sessionPct: 12, refreshedAt: Date.now() - 1000 * 60 * 10 },
    },
  },
};

export const ApiKeyDisabledOrphan: Story = {
  args: {
    account: {
      ...baseAccount,
      id: "acct_openai_backup",
      providerId: "openai-api",
      label: "OpenAI — backup",
      source: "api-key",
      enabled: false,
      priority: 4,
      health: "invalid",
      usage: undefined,
      hasCredential: false,
    },
    isLast: true,
  },
};

export const BusyTesting: Story = {
  args: {
    testBusy: true,
    refreshBusy: true,
  },
};
