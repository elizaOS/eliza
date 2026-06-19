/**
 * Render fixture for OrchestratorAccountsView — mounts every visual state the
 * Storybook stories cover (empty, accounts, assignments, room roster) so the
 * screenshot harness can render + assert them in a real browser without an app
 * server. Mirrors the .stories.tsx args.
 */
import { createRoot } from "react-dom/client";
import type {
  AccountsListResponse,
  AccountWithCredentialFlag,
} from "../../../../api/client-agent";
import type {
  OrchestratorAccountOverview,
  OrchestratorRoomRosterOverview,
} from "../../../../api/client-types-cloud";
import { OrchestratorAccountsView } from "../agent-orchestrator-accounts-view";

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
  ],
};

const overview: OrchestratorAccountOverview = {
  strategy: "least-used",
  availability: {
    claude: [
      { providerId: "anthropic-subscription", total: 2, enabled: 2, healthy: 2 },
    ],
    codex: [{ providerId: "openai-codex", total: 1, enabled: 1, healthy: 1 }],
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

function Panel({ title, children }: { title: string; children: unknown }) {
  return (
    <div className="w-[320px]">
      <div className="mb-1 text-3xs uppercase tracking-wide text-muted/60">
        {title}
      </div>
      <div className="rounded-lg border border-border/40 bg-bg/40 p-3">
        {children as never}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <div
    data-testid="orchestrator-accounts-fixture"
    style={{ display: "flex", gap: 16, flexWrap: "wrap", padding: 16 }}
  >
    <Panel title="Empty">
      <OrchestratorAccountsView
        accounts={{ providers: [] }}
        overview={null}
        rooms={null}
      />
    </Panel>
    <Panel title="Accounts only">
      <OrchestratorAccountsView
        accounts={accounts}
        overview={overview}
        rooms={null}
      />
    </Panel>
    <Panel title="With assignments">
      <OrchestratorAccountsView
        accounts={accounts}
        overview={overview}
        rooms={{ rooms: [] }}
      />
    </Panel>
    <Panel title="With room roster">
      <OrchestratorAccountsView
        accounts={accounts}
        overview={overview}
        rooms={rooms}
      />
    </Panel>
  </div>,
);
