import type {
  CloudCompatAgent,
  CloudCompatManagedGithubStatus,
  CloudOAuthConnection,
} from "@elizaos/ui";
import { Badge, Button } from "@elizaos/ui";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import type {
  LifeOpsActiveReminderView,
  LifeOpsCadence,
  LifeOpsGoalDefinition,
  LifeOpsOccurrenceView,
} from "../contracts/index.js";
import { humanizeLifeOpsLabel } from "./lifeops-labels.js";

export type ManagedAgentGithubEntry = {
  agent: CloudCompatAgent;
  github: CloudCompatManagedGithubStatus | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function cadenceLabel(cadence: LifeOpsCadence): string {
  switch (cadence.kind) {
    case "once":
      return "One-off";
    case "daily":
      return cadence.windows.length > 0 ? "Daily" : "Every day";
    case "times_per_day":
      return cadence.slots.length <= 1
        ? "Daily"
        : `${cadence.slots.length}x daily`;
    case "interval":
      return cadence.everyMinutes >= 60 && cadence.everyMinutes % 60 === 0
        ? `Every ${cadence.everyMinutes / 60}h`
        : `Every ${cadence.everyMinutes}m`;
    case "weekly":
      return cadence.weekdays.length > 0 ? "Weekly" : "As needed";
  }
}

export function occurrenceSortValue(occurrence: LifeOpsOccurrenceView): number {
  const candidates = [
    occurrence.dueAt,
    occurrence.snoozedUntil,
    occurrence.scheduledAt,
    occurrence.relevanceStartAt,
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

function occurrenceWindowLabel(occurrence: LifeOpsOccurrenceView): string {
  if (occurrence.snoozedUntil) {
    return `Snoozed until ${formatDateTime(occurrence.snoozedUntil)}`;
  }
  if (occurrence.dueAt) {
    return `Due ${formatDateTime(occurrence.dueAt)}`;
  }
  if (occurrence.scheduledAt) {
    return `Scheduled ${formatDateTime(occurrence.scheduledAt)}`;
  }
  return `Visible ${formatDateTime(occurrence.relevanceStartAt)}`;
}

function githubIdentityLabel(connection: {
  displayName?: string | null;
  username?: string | null;
  email?: string | null;
}): string {
  const displayName =
    typeof connection.displayName === "string" &&
    connection.displayName.trim().length > 0
      ? connection.displayName.trim()
      : null;
  const username =
    typeof connection.username === "string" &&
    connection.username.trim().length > 0
      ? `@${connection.username.trim()}`
      : null;
  const email =
    typeof connection.email === "string" && connection.email.trim().length > 0
      ? connection.email.trim()
      : null;

  return displayName ?? username ?? email ?? "No account linked";
}

function githubOwnerActionLabel(connection: CloudOAuthConnection): string {
  return connection.username?.trim()
    ? `@${connection.username.trim()}`
    : githubIdentityLabel(connection);
}

function githubBindingModeLabel(
  mode: CloudCompatManagedGithubStatus["mode"] | null | undefined,
): string | null {
  switch (mode) {
    case "cloud-managed":
      return "Agent account";
    case "shared-owner":
      return "Shared LifeOps account";
    default:
      return null;
  }
}

function githubBindingSourceLabel(
  source: CloudCompatManagedGithubStatus["source"] | null | undefined,
): string | null {
  switch (source) {
    case "platform_credentials":
      return "Eliza Cloud OAuth";
    case "secrets":
      return "Cloud secret";
    default:
      return null;
  }
}

export function SectionSurface({
  title,
  icon,
  subtitle,
  children,
}: {
  title: string;
  icon: ReactNode;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-muted">
        {icon}
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">
          {title}
        </div>
      </div>
      {subtitle ? (
        <div className="mt-1 text-xs leading-5 text-muted">{subtitle}</div>
      ) : null}
      <div className="mt-2 space-y-2">{children}</div>
    </div>
  );
}

export function SummaryMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/40 bg-bg/72 p-4">
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted">
        {label}
      </div>
      <div className="mt-2 text-lg font-semibold text-txt">{value}</div>
      {detail ? (
        <div className="mt-1 text-xs-tight text-muted">{detail}</div>
      ) : null}
    </div>
  );
}

export function OccurrenceList({
  occurrences,
}: {
  occurrences: LifeOpsOccurrenceView[];
}) {
  if (occurrences.length === 0) {
    return <div className="py-3 text-xs text-muted/60">No active items.</div>;
  }

  return (
    <>
      {occurrences.map((occurrence) => (
        <div
          key={occurrence.id}
          className="rounded-2xl border border-border/40 bg-bg/60 p-3"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-txt">
                {occurrence.title}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted">
                {occurrenceWindowLabel(occurrence)}
              </div>
            </div>
            <Badge variant="secondary" className="text-2xs">
              {humanizeLifeOpsLabel(occurrence.state)}
            </Badge>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs-tight text-muted">
            <span>{cadenceLabel(occurrence.cadence)}</span>
            <span>Priority {occurrence.priority}</span>
            <span>{humanizeLifeOpsLabel(occurrence.domain)}</span>
          </div>
          {occurrence.description.trim().length > 0 ? (
            <div className="mt-2 text-xs leading-5 text-muted">
              {occurrence.description}
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

export function GoalList({ goals }: { goals: LifeOpsGoalDefinition[] }) {
  if (goals.length === 0) {
    return <div className="py-3 text-xs text-muted/60">No active goals.</div>;
  }

  return (
    <>
      {goals.map((goal) => {
        const goalMetadata = isRecord(goal.metadata) ? goal.metadata : null;
        const grounding =
          goalMetadata && isRecord(goalMetadata.goalGrounding)
            ? (goalMetadata.goalGrounding as Record<string, unknown>)
            : null;
        const groundingSummary =
          grounding && typeof grounding.summary === "string"
            ? grounding.summary
            : null;
        const goalDescription = goal.description.trim() || groundingSummary;
        return (
          <div
            key={goal.id}
            className="rounded-2xl border border-border/40 bg-bg/60 p-3"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-txt">
                  {goal.title}
                </div>
                <div className="mt-1 text-xs leading-5 text-muted">
                  {goalDescription || "No goal detail yet."}
                </div>
              </div>
              <Badge variant="secondary" className="text-2xs">
                {humanizeLifeOpsLabel(goal.reviewState)}
              </Badge>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs-tight text-muted">
              <span>{humanizeLifeOpsLabel(goal.status)}</span>
              <span>{humanizeLifeOpsLabel(goal.domain)}</span>
              <span>Updated {formatDateTime(goal.updatedAt)}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}

export function ReminderList({
  reminders,
}: {
  reminders: LifeOpsActiveReminderView[];
}) {
  if (reminders.length === 0) {
    return <div className="py-3 text-xs text-muted/60">No live reminders.</div>;
  }

  return (
    <>
      {reminders.map((reminder) => (
        <div
          key={reminder.ownerId + reminder.stepIndex}
          className="rounded-2xl border border-border/40 bg-bg/60 p-3"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-txt">
                {reminder.title}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted">
                {reminder.stepLabel} via{" "}
                {humanizeLifeOpsLabel(reminder.channel)}
              </div>
            </div>
            <Badge variant="outline" className="text-2xs">
              {humanizeLifeOpsLabel(reminder.state)}
            </Badge>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs-tight text-muted">
            <span>Scheduled {formatDateTime(reminder.scheduledFor)}</span>
            {reminder.dueAt ? (
              <span>Due {formatDateTime(reminder.dueAt)}</span>
            ) : null}
          </div>
        </div>
      ))}
    </>
  );
}

export function OwnerGithubConnectionCard({
  connection,
  busy,
  onDisconnect,
}: {
  connection: CloudOAuthConnection;
  busy: boolean;
  onDisconnect: (connectionId: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-border/40 bg-bg/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-txt">
            {githubIdentityLabel(connection)}
          </div>
          <div className="mt-1 text-xs text-muted">
            {connection.username
              ? `@${connection.username}`
              : (connection.email ?? "GitHub")}
          </div>
        </div>
        <Badge
          variant={connection.status === "active" ? "secondary" : "outline"}
          className="text-2xs"
        >
          {humanizeLifeOpsLabel(connection.status)}
        </Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs-tight text-muted">
        <span>Linked {formatDateTime(connection.linkedAt)}</span>
        <span>{connection.scopes.length} scopes</span>
        {connection.connectionRole ? (
          <span>{humanizeLifeOpsLabel(connection.connectionRole)}</span>
        ) : null}
      </div>
      {connection.scopes.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {connection.scopes.slice(0, 4).map((scope) => (
            <Badge key={scope} variant="outline" className="text-2xs">
              {scope}
            </Badge>
          ))}
          {connection.scopes.length > 4 ? (
            <Badge variant="outline" className="text-2xs">
              +{connection.scopes.length - 4} more
            </Badge>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3">
        <Button
          variant="outline"
          size="sm"
          className="rounded-full px-4 text-xs-tight font-semibold"
          disabled={busy}
          onClick={() => onDisconnect(connection.id)}
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}

export function AgentGithubCard({
  entry,
  ownerConnections,
  busyAgentId,
  onConnect,
  onDisconnect,
  onUseOwnerConnection,
}: {
  entry: ManagedAgentGithubEntry;
  ownerConnections: CloudOAuthConnection[];
  busyAgentId: string | null;
  onConnect: (agentId: string) => void;
  onDisconnect: (agentId: string) => void;
  onUseOwnerConnection: (agentId: string, connectionId: string) => void;
}) {
  const { agent, github } = entry;
  const busy = busyAgentId === agent.agent_id;
  const connected = github?.connected === true;
  const bindingModeLabel = githubBindingModeLabel(github?.mode);
  const sourceLabel = githubBindingSourceLabel(github?.source);

  return (
    <div className="rounded-2xl border border-border/40 bg-bg/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-txt">
            {agent.agent_name}
          </div>
          <div className="mt-1 text-xs text-muted">
            {connected
              ? githubIdentityLabel({
                  displayName: github?.githubDisplayName,
                  username: github?.githubUsername,
                  email: github?.githubEmail,
                })
              : "No agent GitHub account linked"}
          </div>
        </div>
        <Badge
          variant={connected ? "secondary" : "outline"}
          className="text-2xs"
        >
          {connected ? "Connected" : "Not connected"}
        </Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs-tight text-muted">
        <span>Agent {humanizeLifeOpsLabel(agent.status)}</span>
        {github?.connectedAt ? (
          <span>Linked {formatDateTime(github.connectedAt)}</span>
        ) : null}
        {bindingModeLabel ? <span>{bindingModeLabel}</span> : null}
        {sourceLabel ? <span>{sourceLabel}</span> : null}
      </div>
      {github?.scopes?.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {github.scopes.slice(0, 4).map((scope) => (
            <Badge key={scope} variant="outline" className="text-2xs">
              {scope}
            </Badge>
          ))}
          {github.scopes.length > 4 ? (
            <Badge variant="outline" className="text-2xs">
              +{github.scopes.length - 4} more
            </Badge>
          ) : null}
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="default"
          size="sm"
          className="rounded-full px-4 text-xs-tight font-semibold"
          disabled={busy || github?.configured === false}
          onClick={() => onConnect(agent.agent_id)}
        >
          <ExternalLink className="mr-2 h-3.5 w-3.5" />
          {connected ? "Reconnect agent GitHub" : "Connect agent GitHub"}
        </Button>
        {connected ? (
          <Button
            variant="outline"
            size="sm"
            className="rounded-full px-4 text-xs-tight font-semibold"
            disabled={busy}
            onClick={() => onDisconnect(agent.agent_id)}
          >
            Disconnect
          </Button>
        ) : null}
      </div>
      {ownerConnections.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-border/35 bg-card/70 p-3">
          <div className="text-xs-tight font-semibold text-txt">
            Use LifeOps GitHub
          </div>
          <div className="mt-1 text-xs-tight leading-5 text-muted">
            Link this agent to one of the owner’s LifeOps GitHub connections
            through Eliza Cloud. Disconnecting the agent later leaves the owner
            connection intact.
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {ownerConnections.map((connection) => {
              const alreadySelected =
                github?.mode === "shared-owner" &&
                github.connectionId === connection.id;
              return (
                <Button
                  key={connection.id}
                  variant="outline"
                  size="sm"
                  className="rounded-full px-4 text-xs-tight font-semibold"
                  disabled={busy || alreadySelected}
                  onClick={() =>
                    onUseOwnerConnection(agent.agent_id, connection.id)
                  }
                >
                  {alreadySelected ? "Using" : "Use"}{" "}
                  {githubOwnerActionLabel(connection)}
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="mt-3 text-xs-tight leading-5 text-muted">
        This account is bound to the cloud agent for coding, pull requests, and
        repo context. Repo access still depends on the GitHub account or app
        installation behind it.
      </div>
    </div>
  );
}
