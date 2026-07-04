/**
 * Storybook + story-gate visual states for OrchestratorAccountsView (the
 * coding-accounts + per-room roster sidebar widget): empty, accounts,
 * assignments, and room-roster. Mirrors the __e2e__ render fixture.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import type {
  AccountsListResponse,
  AccountWithCredentialFlag,
} from "../../../api/client-agent";
import type {
  OrchestratorAccountOverview,
  OrchestratorRoomRosterOverview,
} from "../../../api/client-types-cloud";
import { OrchestratorAccountsView } from "./agent-orchestrator-accounts-view";

// The widget lives in the chat sidebar — render stories in a matching column.
function Sidebar({ children }: { children: ReactNode }) {
  return (
    <div className="w-[320px] rounded-lg border border-border/40 bg-bg/40 p-3">
      {children}
    </div>
  );
}

function acct(
  over: Partial<AccountWithCredentialFlag> & {
    id: string;
    providerId: AccountWithCredentialFlag["providerId"];
    label: string;
  },
): AccountWithCredentialFlag {
  return {
    source: "oauth",
    enabled: true,
    priority: 0,
    createdAt: 1,
    health: "ok",
    hasCredential: true,
    ...over,
  } as AccountWithCredentialFlag;
}

const accounts: AccountsListResponse = {
  providers: [
    {
      providerId: "anthropic-subscription",
      strategy: "least-used",
      accounts: [
        acct({
          id: "claude-work",
          providerId: "anthropic-subscription",
          label: "Claude — Work",
          usage: { sessionPct: 18, weeklyPct: 42, refreshedAt: 1 },
        }),
        acct({
          id: "claude-personal",
          providerId: "anthropic-subscription",
          label: "Claude — Personal",
          usage: { sessionPct: 73, weeklyPct: 55, refreshedAt: 1 },
        }),
      ],
    },
    {
      providerId: "openai-codex",
      strategy: "least-used",
      accounts: [
        acct({
          id: "codex-main",
          providerId: "openai-codex",
          label: "Codex — Main",
          usage: { sessionPct: 5, weeklyPct: 12, refreshedAt: 1 },
        }),
      ],
    },
    {
      providerId: "cerebras-api",
      strategy: "least-used",
      accounts: [
        acct({
          id: "cerebras-1",
          providerId: "cerebras-api",
          label: "Cerebras — Team",
          source: "api-key",
          health: "rate-limited",
        }),
      ],
    },
  ],
};

const overview: OrchestratorAccountOverview = {
  strategy: "least-used",
  availability: {
    claude: [
      {
        providerId: "anthropic-subscription",
        total: 2,
        enabled: 2,
        healthy: 2,
      },
    ],
    codex: [{ providerId: "openai-codex", total: 1, enabled: 1, healthy: 1 }],
    opencode: [
      { providerId: "cerebras-api", total: 1, enabled: 1, healthy: 0 },
    ],
  },
  assignments: [
    {
      taskId: "task-1",
      taskTitle: "Refactor the parser",
      sessionId: "s1",
      label: "Ada",
      framework: "claude",
      status: "tool_running",
      active: true,
      accountProviderId: "anthropic-subscription",
      accountId: "claude-work",
      accountLabel: "Claude — Work",
      inputTokens: 3200,
      outputTokens: 900,
      reasoningTokens: 120,
      cacheTokens: 5000,
      totalTokens: 4220,
      costUsd: 0.04,
      usageState: "measured",
    },
  ],
};

const rooms: OrchestratorRoomRosterOverview = {
  rooms: [
    {
      taskId: "task-1",
      taskTitle: "Refactor the parser",
      status: "active",
      roomId: "room-1",
      activeAgentCount: 2,
      multiParty: true,
      participants: [
        { kind: "orchestrator", id: "orchestrator", label: "Orchestrator" },
        { kind: "user", id: "owner", label: "You" },
        {
          kind: "sub_agent",
          id: "s1",
          label: "Ada (claude)",
          framework: "claude",
          status: "tool_running",
          active: true,
          accountProviderId: "anthropic-subscription",
          accountId: "claude-work",
          accountLabel: "Claude — Work",
          totalTokens: 4220,
          usageState: "measured",
        },
        {
          kind: "sub_agent",
          id: "s2",
          label: "Cody (codex)",
          framework: "codex",
          status: "ready",
          active: true,
          accountProviderId: "openai-codex",
          accountId: "codex-main",
          accountLabel: "Codex — Main",
          totalTokens: 1380,
          usageState: "measured",
        },
      ],
    },
  ],
};

const meta = {
  title: "Chat/Widgets/OrchestratorAccounts",
  component: OrchestratorAccountsView,
  decorators: [
    (Story) => (
      <Sidebar>
        <Story />
      </Sidebar>
    ),
  ],
  args: { accounts: null, overview: null, rooms: null },
} satisfies Meta<typeof OrchestratorAccountsView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No subscriptions connected — the connect-prompt empty state. */
export const Empty: Story = {
  args: { accounts: { providers: [] }, overview: null, rooms: null },
};

/** Accounts + strategy + availability + per-account session/weekly usage bars. */
export const AccountsOnly: Story = {
  args: { accounts, overview, rooms: null },
};

/** Flat sub-agent → account assignment list (no live rooms). */
export const WithAssignments: Story = {
  args: { accounts, overview, rooms: { rooms: [] } },
};

/** The per-room participant roster: orchestrator + user + sub-agents → account. */
export const WithRoomRoster: Story = {
  args: { accounts, overview, rooms },
};
