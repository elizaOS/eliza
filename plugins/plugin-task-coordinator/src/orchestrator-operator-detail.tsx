/**
 * Renders inspectable timeline and session detail without owning task state or mutations.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import type {
  CodingAgentRerunFromEventInput,
  CodingAgentRetryTurnInput,
  CodingAgentTaskEventRecord,
  CodingAgentTaskMessageRecord,
  CodingAgentTaskSessionRecord,
  CodingAgentTaskUsageSummary,
} from "@elizaos/ui/api/client-types-cloud";
import { Button } from "@elizaos/ui/components/ui/button";
import { ChevronsUp, RotateCcw, X } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import { type ConversationBlock, ToolBody } from "./orchestrator-stream";
import {
  compactText,
  hasRecordEntries,
  InspectorSection,
  RecoveryActionButton,
  UsageSection,
} from "./orchestrator-task-inspector";
import type { Translate } from "./orchestrator-workbench-glyphs";
import { formatClockTime, formatDuration } from "./view-format";

type OperatorTab = "input" | "output" | "events" | "usage";
export type DetailDrawerSelection =
  | { kind: "session"; sessionId: string }
  | {
      kind: "block";
      blockKey: string;
      blockKind: ConversationBlock["kind"];
      eventIds: string[];
      messageIds: string[];
    };

function OperatorTabButton({
  active,
  tab,
  onSelect,
}: {
  active: OperatorTab;
  tab: { id: OperatorTab; label: string };
  onSelect: (tab: OperatorTab) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `operator-tab-${tab.id}`,
    role: "tab",
    label: tab.label,
    group: "orchestrator-operator-detail",
    description: `Show the ${tab.label.toLocaleLowerCase()} detail panel`,
  });
  return (
    <Button
      unstyled
      ref={ref}
      type="button"
      role="tab"
      aria-selected={active === tab.id}
      onClick={() => onSelect(tab.id)}
      className={`flex-1 px-1 py-1 text-xs font-medium transition-colors ${
        active === tab.id ? "text-accent" : "text-muted hover:text-txt"
      }`}
      {...agentProps}
    >
      {tab.label}
    </Button>
  );
}

function JsonBlock({
  value,
  emptyLabel,
}: {
  value: unknown;
  emptyLabel: string;
}) {
  const empty =
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length === 0);
  if (empty) {
    return <p className="text-xs-tight text-muted">{emptyLabel}</p>;
  }
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      className="max-h-72 overflow-auto bg-bg/60 px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-muted"
      data-testid="orchestrator-detail-json"
    >
      {compactText(text)}
    </pre>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid grid-cols-[5.25rem_minmax(0,1fr)] gap-2 text-xs-tight">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words text-txt">{value}</span>
    </div>
  );
}

function OperatorTabs({
  active,
  onSelect,
  t,
}: {
  active: OperatorTab;
  onSelect: (tab: OperatorTab) => void;
  t: Translate;
}) {
  const tabs: Array<{ id: OperatorTab; label: string }> = [
    {
      id: "input",
      label: t("orchestrator.detail.tabs.input", { defaultValue: "Input" }),
    },
    {
      id: "output",
      label: t("orchestrator.detail.tabs.output", { defaultValue: "Output" }),
    },
    {
      id: "events",
      label: t("orchestrator.detail.tabs.events", { defaultValue: "Events" }),
    },
    {
      id: "usage",
      label: t("orchestrator.detail.tabs.usage", { defaultValue: "Usage" }),
    },
  ];
  return (
    <div
      className="flex gap-2"
      role="tablist"
      aria-label={t("orchestrator.detail.tabsLabel", {
        defaultValue: "Detail tabs",
      })}
    >
      {tabs.map((tab) => (
        <OperatorTabButton
          key={tab.id}
          active={active}
          tab={tab}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function sessionUsage(
  session: CodingAgentTaskSessionRecord,
): CodingAgentTaskUsageSummary {
  return {
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    reasoningTokens: session.reasoningTokens,
    cacheTokens: session.cacheTokens,
    totalTokens: session.totalTokens,
    costUsd: session.costUsd,
    state: session.usageState,
    byProvider: [
      {
        provider: session.providerSource ?? session.framework,
        model: session.model ?? undefined,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        reasoningTokens: session.reasoningTokens,
        cacheTokens: session.cacheTokens,
        totalTokens: session.totalTokens,
        costUsd: session.costUsd,
        state: session.usageState,
      },
    ],
  };
}

function blockEventIds(block: ConversationBlock): string[] {
  if (block.kind === "tool") return block.tool.eventIds;
  if (block.kind === "reasoning") return block.eventIds;
  if (block.kind === "notice") return [block.eventId];
  return [];
}

function blockMessageIds(block: ConversationBlock): string[] {
  if (block.kind === "user" || block.kind === "agent") return block.messageIds;
  return [];
}

export function blockSelection(
  block: ConversationBlock,
): Extract<DetailDrawerSelection, { kind: "block" }> {
  return {
    kind: "block",
    blockKey: block.key,
    blockKind: block.kind,
    eventIds: blockEventIds(block),
    messageIds: blockMessageIds(block),
  };
}

export function blockMatchesSelection(
  block: ConversationBlock,
  selection: Extract<DetailDrawerSelection, { kind: "block" }>,
): boolean {
  if (block.key === selection.blockKey) return true;
  if (block.kind !== selection.blockKind) return false;
  const eventIds = blockEventIds(block);
  if (
    selection.eventIds.length > 0 &&
    selection.eventIds.some((id) => eventIds.includes(id))
  ) {
    return true;
  }
  const messageIds = blockMessageIds(block);
  return (
    selection.messageIds.length > 0 &&
    selection.messageIds.some((id) => messageIds.includes(id))
  );
}

export function blockSelectionKey(selection: DetailDrawerSelection): string {
  if (selection.kind === "session") return `session:${selection.sessionId}`;
  return [
    "block",
    selection.blockKey,
    selection.blockKind,
    selection.eventIds.join(","),
    selection.messageIds.join(","),
  ].join(":");
}

export function blockTitle(block: ConversationBlock, t: Translate): string {
  if (block.kind === "tool") return block.tool.title;
  if (block.kind === "agent") return block.senderName;
  if (block.kind === "user")
    return t("orchestrator.detail.userTurn", { defaultValue: "User turn" });
  if (block.kind === "reasoning")
    return t("orchestrator.detail.reasoning", { defaultValue: "Reasoning" });
  return block.eventType.replace(/_/g, " ");
}

function eventError(
  events: CodingAgentTaskEventRecord[],
  t: Translate,
): string | null {
  const error = events.find((event) => event.eventType === "error");
  if (!error) return null;
  const message =
    typeof error.data?.message === "string"
      ? error.data.message
      : typeof error.data?.error === "string"
        ? error.data.error
        : error.summary;
  return (
    message.trim() ||
    t("orchestrator.detail.errorFallback", { defaultValue: "Error" })
  );
}

function blockError(
  block: ConversationBlock | null,
  events: CodingAgentTaskEventRecord[],
  t: Translate,
): string | null {
  const fromEvent = eventError(events, t);
  if (fromEvent) return fromEvent;
  if (!block) return null;
  if (block.kind === "agent" && block.tone === "error") {
    return compactText(block.content, 600);
  }
  if (block.kind === "notice" && block.eventType === "error") {
    return block.text;
  }
  if (block.kind === "tool" && block.tool.status === "failed") {
    if (block.tool.output) return compactText(block.tool.output, 600);
    if (typeof block.tool.exitCode === "number") {
      return t("orchestrator.detail.toolExited", {
        defaultValue: `Tool exited with code ${block.tool.exitCode}.`,
        code: block.tool.exitCode,
      });
    }
    return (
      block.tool.rawStatus ??
      t("orchestrator.detail.toolFailed", { defaultValue: "Tool failed." })
    );
  }
  return null;
}

function sessionError(
  session: CodingAgentTaskSessionRecord,
  t: Translate,
): string | null {
  if (session.status !== "error" && session.status !== "errored") return null;
  return (
    session.completionSummary ??
    session.activeTool ??
    t("orchestrator.detail.sessionFailed", {
      defaultValue: "Session failed.",
    })
  );
}

function ErrorFirstBanner({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="rounded-md bg-red-500/10 px-2.5 py-2 text-xs-tight text-red-500">
      {text}
    </div>
  );
}

function OperatorDrawerShell({
  title,
  subtitle,
  closeLabel,
  className,
  style,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  closeLabel: string;
  className?: string;
  style?: CSSProperties;
  onClose: () => void;
  children: ReactNode;
}) {
  const { ref: closeRef, agentProps: closeAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "operator-detail-close",
      role: "button",
      label: closeLabel,
      group: "orchestrator-operator-detail",
      description: "Close the timeline or session detail panel",
    });
  return (
    <div
      className={`shrink-0 flex-col gap-2.5 overflow-y-auto bg-bg p-3 ${className ?? "flex w-80"}`}
      style={style}
      data-testid="orchestrator-operator-detail"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-medium text-muted">{title}</h3>
          <p className="mt-0.5 truncate text-xs-tight font-medium text-txt">
            {subtitle}
          </p>
        </div>
        <Button
          unstyled
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="-mr-1 p-1 text-muted transition-colors hover:text-txt"
          aria-label={closeLabel}
          data-testid="orchestrator-close-operator-detail"
          {...closeAgentProps}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {children}
    </div>
  );
}

function EventList({
  events,
  messages,
  locale,
  t,
}: {
  events: CodingAgentTaskEventRecord[];
  messages: CodingAgentTaskMessageRecord[];
  locale?: string;
  t: Translate;
}) {
  if (events.length === 0 && messages.length === 0) {
    return (
      <p className="text-xs-tight text-muted">
        {t("orchestrator.detail.noEvents", {
          defaultValue: "No events captured.",
        })}
      </p>
    );
  }
  const timeline = [
    ...messages.map((message) => ({
      kind: "message" as const,
      id: message.id,
      timestamp: message.timestamp,
      record: message,
    })),
    ...events.map((event) => ({
      kind: "event" as const,
      id: event.id,
      timestamp: event.timestamp,
      record: event,
    })),
  ].sort((a, b) => {
    const aTime =
      typeof a.timestamp === "number" && Number.isFinite(a.timestamp)
        ? a.timestamp
        : 0;
    const bTime =
      typeof b.timestamp === "number" && Number.isFinite(b.timestamp)
        ? b.timestamp
        : 0;
    return aTime - bTime || a.id.localeCompare(b.id);
  });
  return (
    <div className="space-y-1.5">
      {timeline.map((item) => {
        if (item.kind === "message") {
          const message = item.record;
          return (
            <div key={`message-${message.id}`} className="py-1">
              <div className="mb-1 flex items-center gap-2 text-2xs text-muted">
                <span className="font-semibold text-txt">
                  {message.senderKind}
                </span>
                <span>{message.direction}</span>
                <span className="ml-auto tabular-nums">
                  {formatClockTime(message.timestamp, locale)}
                </span>
              </div>
              <JsonBlock
                value={message}
                emptyLabel={t("orchestrator.detail.noMessagePayload", {
                  defaultValue: "No message payload.",
                })}
              />
            </div>
          );
        }
        const event = item.record;
        return (
          <div key={`event-${event.id}`} className="py-1">
            <div className="mb-1 flex items-center gap-2 text-2xs text-muted">
              <span className="font-semibold text-txt">
                {event.eventType.replace(/_/g, " ")}
              </span>
              <span className="ml-auto tabular-nums">
                {formatClockTime(event.timestamp, locale)}
              </span>
            </div>
            {event.summary ? (
              <p className="mb-1 text-xs-tight text-txt">{event.summary}</p>
            ) : null}
            <JsonBlock
              value={event.data}
              emptyLabel={t("orchestrator.detail.noEventData", {
                defaultValue: "No event data.",
              })}
            />
          </div>
        );
      })}
    </div>
  );
}

export function OperatorDetailDrawer({
  selection,
  block,
  session,
  events,
  messages,
  taskUsage,
  busy,
  className,
  style,
  onClose,
  onRetry,
  onRerun,
  t,
  locale,
}: {
  selection: DetailDrawerSelection;
  block: ConversationBlock | null;
  session: CodingAgentTaskSessionRecord | null;
  events: CodingAgentTaskEventRecord[];
  messages: CodingAgentTaskMessageRecord[];
  taskUsage: CodingAgentTaskUsageSummary;
  busy: boolean;
  className?: string;
  style?: CSSProperties;
  onClose: () => void;
  onRetry: (input: CodingAgentRetryTurnInput) => void;
  onRerun: (input: CodingAgentRerunFromEventInput) => void;
  t: Translate;
  locale?: string;
}) {
  const [tab, setTab] = useState<OperatorTab>("input");
  const closeDetailsLabel = t("orchestrator.detail.close", {
    defaultValue: "Close details",
  });
  const label = (key: string, defaultValue: string) =>
    t(`orchestrator.detail.${key}`, { defaultValue });

  if (selection.kind === "session" && !session) {
    return (
      <OperatorDrawerShell
        title={t("orchestrator.detail.session", { defaultValue: "Session" })}
        subtitle={t("orchestrator.detail.noLongerAvailable", {
          defaultValue: "No longer available",
        })}
        closeLabel={closeDetailsLabel}
        className={className}
        style={style}
        onClose={onClose}
      >
        <p className="text-xs-tight text-muted">
          {t("orchestrator.detail.sessionDataChanged", {
            defaultValue: "Session data changed.",
          })}
        </p>
      </OperatorDrawerShell>
    );
  }
  if (selection.kind === "block" && !block) {
    return (
      <OperatorDrawerShell
        title={t("orchestrator.detail.event", { defaultValue: "Event" })}
        subtitle={t("orchestrator.detail.noLongerAvailable", {
          defaultValue: "No longer available",
        })}
        closeLabel={closeDetailsLabel}
        className={className}
        style={style}
        onClose={onClose}
      >
        <p className="text-xs-tight text-muted">
          {t("orchestrator.detail.timelineDataChanged", {
            defaultValue: "Timeline data changed.",
          })}
        </p>
      </OperatorDrawerShell>
    );
  }

  const isSession = selection.kind === "session";
  const title = isSession
    ? t("orchestrator.detail.sessionDetail", { defaultValue: "Session detail" })
    : t("orchestrator.detail.timelineDetail", {
        defaultValue: "Timeline detail",
      });
  const subtitle = isSession
    ? (session?.label ??
      t("orchestrator.detail.session", { defaultValue: "Session" }))
    : block
      ? blockTitle(block, t)
      : t("orchestrator.detail.event", { defaultValue: "Event" });
  const activeUsage = session ? sessionUsage(session) : taskUsage;
  const toolUsageFallbackLabel = session
    ? label(
        "perToolUsageUnavailable",
        "Per-tool usage is not emitted yet; showing the owning session total.",
      )
    : label(
        "perToolUsageTaskFallback",
        "Per-tool usage is not emitted yet; showing the task total.",
      );
  const errorText =
    isSession && session
      ? sessionError(session, t)
      : block
        ? blockError(block, events, t)
        : null;
  const retryMessage = !isSession ? messages[0] : null;
  const rerunEvent = !isSession ? events[0] : null;
  const retryLabel = label("retry", "Retry");
  const rerunLabel = label("rerun", "Rerun");
  const recoveryActions: ReactNode[] = [];
  if (isSession && session) {
    recoveryActions.push(
      <RecoveryActionButton
        key="retry-session"
        agentId="operator-retry-session"
        description="Retry this session's work in a new worker"
        icon={<RotateCcw className="h-3 w-3" />}
        label={retryLabel}
        onClick={() =>
          onRetry({
            sessionId: session.sessionId,
            mode: "new-session",
            instruction: `Retry work from session ${session.label ?? session.sessionId}.`,
          })
        }
        disabled={busy}
        testId="orchestrator-detail-retry"
      />,
    );
  } else if (retryMessage) {
    recoveryActions.push(
      <RecoveryActionButton
        key="retry-message"
        agentId="operator-retry-message"
        description="Retry this selected turn in a new worker"
        icon={<RotateCcw className="h-3 w-3" />}
        label={retryLabel}
        onClick={() =>
          onRetry({
            messageId: retryMessage.id,
            sessionId: retryMessage.sessionId ?? undefined,
            mode: "new-session",
            instruction: "Retry this selected turn.",
          })
        }
        disabled={busy}
        testId="orchestrator-detail-retry"
      />,
    );
  }
  if (rerunEvent) {
    recoveryActions.push(
      <RecoveryActionButton
        key="rerun-event"
        agentId="operator-rerun-event"
        description="Rerun from this selected event without rewriting history"
        icon={<ChevronsUp className="h-3 w-3" />}
        label={rerunLabel}
        onClick={() =>
          onRerun({
            eventId: rerunEvent.id,
            instruction: `Rerun from ${rerunEvent.eventType.replace(/_/g, " ")}.`,
            stopActive: false,
            preserveHistory: true,
          })
        }
        disabled={busy}
        testId="orchestrator-detail-rerun"
      />,
    );
  }

  let body: ReactNode;
  if (tab === "input") {
    if (isSession && session) {
      body = (
        <div className="space-y-2">
          <DetailRow
            label={label("status", "Status")}
            value={session.status.replace(/_/g, " ")}
          />
          <DetailRow
            label={label("framework", "Framework")}
            value={session.framework}
          />
          <DetailRow
            label={label("provider", "Provider")}
            value={session.providerSource}
          />
          <DetailRow label={label("model", "Model")} value={session.model} />
          <DetailRow
            label={label("workdir", "Workdir")}
            value={session.workdir}
          />
          <DetailRow label={label("repo", "Repo")} value={session.repo} />
          <InspectorSection title={label("originalTask", "Original task")}>
            <p className="whitespace-pre-wrap text-xs-tight text-txt">
              {session.originalTask}
            </p>
          </InspectorSection>
          {hasRecordEntries(session.metadata) ? (
            <InspectorSection title={label("metadata", "Metadata")}>
              <JsonBlock
                value={session.metadata}
                emptyLabel={label("noMetadata", "No metadata.")}
              />
            </InspectorSection>
          ) : null}
        </div>
      );
    } else if (block?.kind === "tool") {
      const input = block.tool.rawInput ?? {};
      body = (
        <div className="space-y-2">
          <DetailRow label={label("toolId", "Tool id")} value={block.tool.id} />
          <DetailRow
            label={label("kind", "Kind")}
            value={block.tool.kind || "tool"}
          />
          <DetailRow
            label={label("status", "Status")}
            value={block.tool.rawStatus ?? block.tool.status}
          />
          <DetailRow
            label={label("file", "File")}
            value={block.tool.filePath}
          />
          <DetailRow
            label={label("command", "Command")}
            value={block.tool.command}
          />
          <DetailRow label={label("query", "Query")} value={block.tool.query} />
          <JsonBlock
            value={input}
            emptyLabel={label("noToolInput", "No tool input captured.")}
          />
        </div>
      );
    } else if (block?.kind === "user") {
      body = (
        <pre className="whitespace-pre-wrap bg-bg/60 px-2.5 py-1.5 text-xs-tight text-txt">
          {block.content}
        </pre>
      );
    } else if (block?.kind === "agent") {
      body = (
        <JsonBlock
          value={messages.map((message) => message.metadata)}
          emptyLabel={label("noInputMetadata", "No input metadata captured.")}
        />
      );
    } else {
      body = (
        <JsonBlock
          value={events.map((event) => event.data)}
          emptyLabel={label("noInput", "No input captured.")}
        />
      );
    }
  } else if (tab === "output") {
    if (isSession && session) {
      body = (
        <div className="space-y-2">
          <DetailRow
            label={label("activeTool", "Active tool")}
            value={session.activeTool}
          />
          <DetailRow
            label={label("decisions", "Decisions")}
            value={t("orchestrator.detail.decisionCounts", {
              defaultValue: `${session.decisionCount} total · ${session.autoResolvedCount} auto`,
              count: session.decisionCount,
              auto: session.autoResolvedCount,
            })}
          />
          <DetailRow
            label={label("lastInput", "Last input")}
            value={
              session.lastInputSentAt
                ? formatClockTime(session.lastInputSentAt, locale)
                : null
            }
          />
          <InspectorSection title={label("completion", "Completion")}>
            {session.completionSummary ? (
              <p className="whitespace-pre-wrap text-xs-tight text-txt">
                {session.completionSummary}
              </p>
            ) : (
              <p className="text-xs-tight text-muted">
                {label("noCompletion", "No completion yet.")}
              </p>
            )}
          </InspectorSection>
        </div>
      );
    } else if (block?.kind === "tool") {
      body = (
        <div className="space-y-2">
          <DetailRow
            label={label("exit", "Exit")}
            value={block.tool.exitCode}
          />
          <DetailRow
            label={label("duration", "Duration")}
            value={
              block.tool.durationMs
                ? formatDuration(block.tool.durationMs)
                : null
            }
          />
          <ToolBody tool={block.tool} />
          <JsonBlock
            value={block.tool.rawOutput}
            emptyLabel={label("noRawOutput", "No raw output payload captured.")}
          />
        </div>
      );
    } else if (block?.kind === "agent" || block?.kind === "user") {
      body = (
        <pre className="whitespace-pre-wrap bg-bg/60 px-2.5 py-1.5 text-xs-tight text-txt">
          {compactText(block.content)}
        </pre>
      );
    } else if (block?.kind === "reasoning") {
      body = (
        <pre className="whitespace-pre-wrap bg-bg/60 px-2.5 py-1.5 text-xs-tight text-txt">
          {compactText(block.text)}
        </pre>
      );
    } else if (block) {
      body = <p className="text-xs-tight text-txt">{block.text}</p>;
    } else {
      body = null;
    }
  } else if (tab === "events") {
    body = (
      <EventList events={events} messages={messages} locale={locale} t={t} />
    );
  } else {
    body = (
      <div className="space-y-2">
        {block?.kind === "tool" ? (
          <p className="text-xs-tight text-muted">{toolUsageFallbackLabel}</p>
        ) : null}
        <UsageSection usage={activeUsage} t={t} locale={locale} />
      </div>
    );
  }

  return (
    <OperatorDrawerShell
      title={title}
      subtitle={subtitle}
      closeLabel={closeDetailsLabel}
      className={className}
      style={style}
      onClose={onClose}
    >
      <ErrorFirstBanner text={errorText} />
      <div className="space-y-1.5">
        {session ? (
          <>
            <DetailRow
              label={label("session", "Session")}
              value={session.sessionId}
            />
            <DetailRow
              label={label("activity", "Activity")}
              value={formatClockTime(session.lastActivityAt, locale)}
            />
          </>
        ) : null}
        {block ? (
          <>
            <DetailRow label={label("kind", "Kind")} value={block.kind} />
            <DetailRow
              label={label("time", "Time")}
              value={formatClockTime(block.at, locale)}
            />
          </>
        ) : null}
      </div>
      {recoveryActions.length > 0 ? (
        <div className="space-y-1.5" data-testid="orchestrator-detail-recovery">
          <div className="text-xs font-medium text-muted">
            {label("recovery", "Recovery")}
          </div>
          <div className="flex flex-wrap gap-1.5">{recoveryActions}</div>
        </div>
      ) : null}
      <OperatorTabs active={tab} onSelect={setTab} t={t} />
      <div className="min-h-0">{body}</div>
    </OperatorDrawerShell>
  );
}
