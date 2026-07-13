/**
 * Storybook stories for ProviderAccountRow — the unified Accounts row across
 * connected/disconnected, healthy/attention, and rotation-selection states.
 * Renders under a stub AppContext supplying `t`.
 */

import type { Meta, StoryObj } from "@storybook/react";
import type {
  AccountsListProvider,
  AccountWithCredentialFlag,
} from "../../api/client-agent";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import {
  type AccountProviderOption,
  getAccountProviderOption,
} from "./account-provider-options";
import { ProviderAccountRow } from "./ProviderAccountRow";

function option(
  id: Parameters<typeof getAccountProviderOption>[0],
): AccountProviderOption {
  const found = getAccountProviderOption(id);
  if (!found) throw new Error(`missing provider option: ${id}`);
  return found;
}

const mockAppContext = new Proxy({} as AppContextValue, {
  get(_, prop) {
    if (prop === "t") {
      return (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? "";
    }
    if (prop === "uiLanguage") return "en";
    if (prop === "navigation") {
      return {
        scheduleAfterTabCommit: (fn: () => void) => queueMicrotask(fn),
      };
    }
    return () => {};
  },
});

function acct(
  over: Partial<AccountWithCredentialFlag> &
    Pick<AccountWithCredentialFlag, "id" | "providerId" | "label">,
): AccountWithCredentialFlag {
  return {
    source: "oauth",
    enabled: true,
    priority: 1,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 7,
    lastUsedAt: Date.now() - 1000 * 60 * 30,
    health: "ok",
    hasCredential: true,
    ...over,
  };
}

const anthropicProvider: AccountsListProvider = {
  providerId: "anthropic-subscription",
  strategy: "reset-soonest",
  runtimeEligibility: {
    chat: false,
    codingAgent: true,
    note: "Powers coding agents. Not the default chat brain.",
  },
  selection: { activeAccountId: "acct_a2", reason: "reset-soonest" },
  accounts: [
    acct({
      id: "acct_a1",
      providerId: "anthropic-subscription",
      label: "Nadia — studio",
      priority: 1,
      usage: {
        sessionPct: 22,
        weeklyPct: 40,
        resetsAt: Date.now() + 1000 * 60 * 60 * 52,
        refreshedAt: Date.now() - 1000 * 60 * 4,
      },
    }),
    acct({
      id: "acct_a2",
      providerId: "anthropic-subscription",
      label: "Theo — overflow",
      priority: 2,
      usage: {
        sessionPct: 61,
        weeklyPct: 74,
        resetsAt: Date.now() + 1000 * 60 * 60 * 14,
        refreshedAt: Date.now() - 1000 * 60 * 2,
      },
    }),
  ],
};

const meta = {
  title: "Accounts/ProviderAccountRow",
  component: ProviderAccountRow,
  decorators: [
    (Story) => (
      <AppContext.Provider value={mockAppContext}>
        <div className="max-w-3xl bg-bg p-6">
          <Story />
        </div>
      </AppContext.Provider>
    ),
  ],
  args: {
    onToggle: () => {},
    onAdd: () => {},
    saving: new Set<string>(),
    onPatch: async () => {},
    onMove: async () => {},
    onTest: async () => {},
    onRefreshUsage: async () => {},
    onDelete: async () => {},
    onStrategyChange: () => {},
  },
} satisfies Meta<typeof ProviderAccountRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectedCollapsed: Story = {
  args: {
    option: option("anthropic-subscription"),
    provider: anthropicProvider,
    expanded: false,
  },
};

export const ConnectedExpanded: Story = {
  args: {
    option: option("anthropic-subscription"),
    provider: anthropicProvider,
    expanded: true,
  },
};

export const NeedsAttention: Story = {
  args: {
    option: option("openai-codex"),
    expanded: false,
    provider: {
      providerId: "openai-codex",
      strategy: "priority",
      runtimeEligibility: { chat: false, codingAgent: true },
      selection: { activeAccountId: "acct_c1", reason: "priority" },
      accounts: [
        acct({
          id: "acct_c1",
          providerId: "openai-codex",
          label: "Codex — main",
          health: "needs-reauth",
          usage: { sessionPct: 12, refreshedAt: Date.now() - 1000 * 60 * 8 },
        }),
      ],
    },
  },
};

export const DisconnectedChatProvider: Story = {
  args: {
    option: option("anthropic-api"),
    provider: undefined,
    expanded: false,
  },
};
