/**
 * Storybook stories for ProviderAccountRow — the unified Accounts row across
 * connected/disconnected, healthy/attention, and rotation-selection states.
 * Renders under the shared MockAppProvider.
 */

import type { Meta, StoryObj } from "@storybook/react";
import type {
  AccountsListProvider,
  AccountWithCredentialFlag,
} from "../../api/client-agent";
import { MockAppProvider } from "../../storybook/mock-providers";
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
    chat: { available: false },
    codingAgent: { available: true, backend: "claude" },
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
      <MockAppProvider>
        <div className="max-w-3xl bg-bg p-6">
          <Story />
        </div>
      </MockAppProvider>
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
      runtimeEligibility: {
        chat: { available: true },
        codingAgent: { available: true, backend: "codex" },
      },
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
