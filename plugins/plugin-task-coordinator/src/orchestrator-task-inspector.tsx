/**
 * Renders orchestrator status and task-inspector controls while preserving task mutation boundaries.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import type {
  ChangeSetData,
  CodingAgentAddAgentInput,
  CodingAgentOrchestratorStatus,
  CodingAgentRestartWithEditedPlanInput,
  CodingAgentTaskArtifactRecord,
  CodingAgentTaskSessionRecord,
  CodingAgentTaskThreadDetail,
  CodingAgentTaskUsageSummary,
} from "@elizaos/ui/api/client-types-cloud";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  DiffReviewPanel,
} from "@elizaos/ui/components";
import { Button } from "@elizaos/ui/components/ui/button";
import { Input } from "@elizaos/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui/components/ui/select";
import { Textarea } from "@elizaos/ui/components/ui/textarea";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Copy,
  Gauge,
  GitFork,
  Layers,
  PanelRightOpen,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { paramPriority, type TaskPriority } from "./orchestrator-params";
import {
  labelPriority,
  PlanStepGlyph,
  SessionGlyph,
  TERMINAL_TASK_STATUSES,
  type Translate,
  VerificationGlyph,
} from "./orchestrator-workbench-glyphs";
import { formatCompactNumber, formatUsd } from "./view-format";

interface NormalizedPlan {
  summary: string | null;
  /** `key` is the step's ordinal identity within this plan snapshot (plans are
   * ordered and steps carry no server id), used for stable React keys. */
  steps: { key: string; label: string; status: string | null }[];
}

/** Adapt the free-form `currentPlan` record into a renderable shape, or null
 * when it carries no recognizable summary/steps (so we never dump raw JSON). */
function normalizePlan(
  plan: Record<string, unknown> | null,
): NormalizedPlan | null {
  if (!plan) return null;
  const summary = typeof plan.summary === "string" ? plan.summary : null;
  const rawSteps = Array.isArray(plan.steps) ? plan.steps : [];
  const steps: NormalizedPlan["steps"] = [];
  for (const raw of rawSteps) {
    if (typeof raw === "string" && raw.trim()) {
      steps.push({
        key: `step-${steps.length}`,
        label: raw.trim(),
        status: null,
      });
      continue;
    }
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const label =
        (typeof obj.title === "string" && obj.title) ||
        (typeof obj.label === "string" && obj.label) ||
        (typeof obj.description === "string" && obj.description) ||
        null;
      if (!label) continue;
      steps.push({
        key: `step-${steps.length}`,
        label,
        status: typeof obj.status === "string" ? obj.status : null,
      });
    }
  }
  if (!summary && steps.length === 0) return null;
  return { summary, steps };
}

// --- Usage rendering -------------------------------------------------------
// Token/cost figures are computed server-side. The client only formats them and
// honors `state` so "unavailable" never renders as a misleading confident zero.

type UsageState = "measured" | "estimated" | "unavailable";

// Shared token formatter so every surface (header, inspector total, per-provider
// breakdown, sub-agent cards) renders the same `~` estimated prefix and `—`
// unavailable marker instead of a misleading confident number.
function formatTokenCount(
  state: UsageState,
  totalTokens: number,
  t: Translate,
  locale?: string,
): string {
  if (state === "unavailable") {
    return t("orchestrator.usage.unavailable", { defaultValue: "—" });
  }
  const value = formatCompactNumber(totalTokens, locale);
  return state === "estimated"
    ? t("orchestrator.usage.estimatedTokens", {
        defaultValue: "~{{value}}",
        value,
      })
    : value;
}

function renderTokens(
  usage: CodingAgentTaskUsageSummary,
  t: Translate,
  locale?: string,
): string {
  return formatTokenCount(usage.state, usage.totalTokens, t, locale);
}

function renderCost(
  usage: CodingAgentTaskUsageSummary,
  t: Translate,
  locale?: string,
): string {
  if (usage.state === "unavailable") {
    return t("orchestrator.usage.unavailable", { defaultValue: "—" });
  }
  const value = formatUsd(usage.costUsd, locale);
  return usage.state === "estimated"
    ? t("orchestrator.usage.estimatedCost", {
        defaultValue: "~{{value}}",
        value,
      })
    : value;
}

/** One labeled count in the header summary — a baseline-aligned number + tiny
 * label, no pill/border. */
function HeaderStat({
  value,
  label,
  toneClass = "text-txt-strong",
}: {
  value: string;
  label: string;
  toneClass?: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-baseline gap-1" title={label}>
      <span className={`text-sm font-semibold tabular-nums ${toneClass}`}>
        {value}
      </span>
      <span className="text-2xs text-muted">{label}</span>
    </span>
  );
}

/** Borderless inspector section separated by whitespace alone. */
export function InspectorSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function WorkbenchHeader({
  status,
  busy,
  isMobile,
  onPauseAll,
  onResumeAll,
  accountsOpen,
  onToggleAccounts,
  t,
  locale,
}: {
  status: CodingAgentOrchestratorStatus | null;
  busy: boolean;
  isMobile: boolean;
  onPauseAll: () => void;
  onResumeAll: () => void;
  accountsOpen: boolean;
  onToggleAccounts: () => void;
  t: Translate;
  locale?: string;
}) {
  const title = (
    <div className="flex shrink-0 items-center gap-2">
      <Layers className="h-4 w-4 text-accent" />
      <span className="text-sm font-semibold text-txt-strong">
        {t("orchestrator.title", { defaultValue: "Orchestrator" })}
      </span>
    </div>
  );
  // Calm labeled summary: total tasks always, then only the non-zero semantic
  // counts — reads "12 tasks · 1 active · 3 done", not a six-pill debug strip.
  const summary = (
    <div
      className="flex min-w-0 items-center gap-4 overflow-x-auto"
      style={isMobile ? undefined : { flex: "1 1 0%" }}
    >
      <HeaderStat value={String(status?.taskCount ?? 0)} label="tasks" />
      {status?.activeTaskCount ? (
        <HeaderStat
          value={String(status.activeTaskCount)}
          label="active"
          toneClass="text-ok"
        />
      ) : null}
      {status?.blockedTaskCount ? (
        <HeaderStat
          value={String(status.blockedTaskCount)}
          label="blocked"
          toneClass="text-warn"
        />
      ) : null}
      {status?.validatingTaskCount ? (
        <HeaderStat
          value={String(status.validatingTaskCount)}
          label="validating"
          toneClass="text-accent"
        />
      ) : null}
      {status?.activeSessionCount ? (
        <HeaderStat
          value={`${status.activeSessionCount}/${status.sessionCount}`}
          label="agents"
        />
      ) : null}
    </div>
  );
  // Only surface the usage readout once there is real spend to report. An
  // unavailable usage state renders "— · —", which looks like a debug leftover.
  const usageReadout =
    status && status.usage.state !== "unavailable" ? (
      <span
        className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted"
        title={t("orchestrator.stat.usage", { defaultValue: "Usage" })}
      >
        <Gauge className="h-3 w-3 text-muted/70" />
        {renderTokens(status.usage, t, locale)}
        <span className="text-muted/50">·</span>
        {renderCost(status.usage, t, locale)}
      </span>
    ) : null;
  const pauseAllLabel = t("orchestrator.action.pauseAll", {
    defaultValue: "Pause all",
  });
  const resumeAllLabel = t("orchestrator.action.resumeAll", {
    defaultValue: "Resume all",
  });
  const accountsLabel = t("orchestrator.toggleAccounts", {
    defaultValue: "Coding accounts & pool health",
  });
  const { ref: accountsRef, agentProps: accountsAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "header-accounts-toggle",
      role: "toggle",
      label: accountsLabel,
      group: "orchestrator-header",
      description: "Show or hide coding account and pool health",
      status: accountsOpen ? "active" : "inactive",
      onActivate: onToggleAccounts,
    });
  const accountsToggle = (
    <Button
      ref={accountsRef}
      variant="ghost"
      size="sm"
      onClick={onToggleAccounts}
      className="h-7 w-7 shrink-0 p-0"
      aria-label={accountsLabel}
      aria-pressed={accountsOpen}
      title={accountsLabel}
      data-testid="orchestrator-accounts-toggle"
      {...accountsAgentProps}
    >
      <Gauge className="h-3.5 w-3.5" />
    </Button>
  );
  // Pause-all / resume-all only surface while there is something to act on, so a
  // quiet orchestrator shows no controls at all — the dashboard is read-only
  // until work is in flight. New tasks are started conversationally in chat.
  const actions =
    status?.activeTaskCount || status?.pausedTaskCount ? (
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {status?.activeTaskCount ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onPauseAll}
            className="h-7 w-7 p-0"
            aria-label={pauseAllLabel}
            title={pauseAllLabel}
            data-testid="orchestrator-pause-all"
            data-agent-authority="human"
            data-agent-human-id="header-pause-all"
          >
            <Pause className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {status?.pausedTaskCount ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onResumeAll}
            className="h-7 w-7 p-0"
            aria-label={resumeAllLabel}
            title={resumeAllLabel}
            data-testid="orchestrator-resume-all"
            data-agent-authority="human"
            data-agent-human-id="header-resume-all"
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    ) : null;

  if (isMobile) {
    return (
      <header className="flex flex-col gap-2 bg-bg px-4 py-2.5">
        <div className="flex items-center gap-2">
          {title}
          <div className="ml-auto flex items-center gap-1.5">
            {accountsToggle}
            {actions}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          {summary}
          {usageReadout}
        </div>
      </header>
    );
  }

  return (
    <header className="flex items-center gap-4 bg-bg px-4 py-2.5">
      {title}
      {summary}
      {usageReadout}
      {accountsToggle}
      {actions}
    </header>
  );
}

function SubAgentCard({
  session,
  busy,
  onInspect,
  onStop,
  t,
  locale,
}: {
  session: CodingAgentTaskSessionRecord;
  busy: boolean;
  onInspect: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  t: Translate;
  locale?: string;
}) {
  const stoppable = session.stoppedAt == null && session.status !== "completed";
  const provider = [session.framework, session.model]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const workspace =
    session.repo ||
    session.workdir ||
    t("orchestrator.noWorkspace", { defaultValue: "None" });
  const stopLabel = t("orchestrator.action.stopAgent", {
    defaultValue: "Stop agent",
  });
  const inspectLabel = t("orchestrator.action.inspectAgent", {
    defaultValue: "Inspect agent",
  });
  const { ref: inspectRef, agentProps: inspectAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `sub-agent-inspect-${session.sessionId}`,
      role: "button",
      label: `${inspectLabel}: ${session.label}`,
      group: "orchestrator-sub-agents",
      description: `Open recovery and event details for the "${session.label}" sub-agent`,
    });
  return (
    <div className="py-1">
      <div className="flex items-center gap-1.5">
        <SessionGlyph status={session.status} t={t} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-txt">
          {session.label}
        </span>
        <Button
          unstyled
          ref={inspectRef}
          type="button"
          onClick={() => onInspect(session.sessionId)}
          className="flex items-center gap-0.5 px-1 py-0.5 text-2xs text-muted transition-colors hover:text-txt"
          data-testid="orchestrator-inspect-session"
          aria-label={inspectLabel}
          title={inspectLabel}
          {...inspectAgentProps}
        >
          <PanelRightOpen className="h-3 w-3" />
        </Button>
        {stoppable ? (
          <Button
            unstyled
            type="button"
            disabled={busy}
            onClick={() => onStop(session.sessionId)}
            className="flex items-center gap-0.5 px-1 py-0.5 text-2xs text-muted transition-colors hover:text-danger disabled:opacity-50"
            data-testid="orchestrator-stop-agent"
            aria-label={stopLabel}
            data-agent-authority="human"
            data-agent-human-id={`sub-agent-stop-${session.sessionId}`}
          >
            <CircleStop className="h-3 w-3" />
          </Button>
        ) : null}
      </div>
      {provider ? (
        <div className="mt-0.5 truncate text-2xs text-muted">{provider}</div>
      ) : null}
      <div className="mt-0.5 flex items-center gap-2 text-2xs text-muted">
        {session.activeTool ? (
          <span className="truncate text-warn">{session.activeTool}</span>
        ) : null}
        <span className="ml-auto tabular-nums">
          {formatTokenCount(session.usageState, session.totalTokens, t, locale)}
        </span>
      </div>
      <div className="mt-0.5 truncate text-2xs text-muted/80">{workspace}</div>
    </div>
  );
}

function PlanSection({ plan, t }: { plan: NormalizedPlan; t: Translate }) {
  return (
    <InspectorSection title={t("orchestrator.plan", { defaultValue: "Plan" })}>
      {plan.summary ? (
        <p className="mb-2 text-xs-tight text-txt">{plan.summary}</p>
      ) : null}
      {plan.steps.length > 0 ? (
        <ol className="space-y-1">
          {plan.steps.map((step, index) => (
            <li
              key={step.key}
              className="flex items-start gap-1.5 text-xs-tight text-txt"
            >
              <span className="mt-px shrink-0 tabular-nums text-muted">
                {index + 1}.
              </span>
              <span className="min-w-0 flex-1">{step.label}</span>
              {step.status ? (
                <PlanStepGlyph status={step.status} t={t} />
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </InspectorSection>
  );
}

function EditedPlanRestartSection({
  plan,
  latestPlanRevisionId,
  busy,
  onSubmit,
  t,
}: {
  plan: Record<string, unknown>;
  latestPlanRevisionId?: string;
  busy: boolean;
  onSubmit: (input: CodingAgentRestartWithEditedPlanInput) => void;
  t: Translate;
}) {
  const planSource = useMemo(() => JSON.stringify(plan, null, 2), [plan]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(planSource);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toggleLabel = t("orchestrator.action.editPlan", {
    defaultValue: "Edit plan",
  });
  const restartLabel = t("orchestrator.action.restartWithPlan", {
    defaultValue: "Restart with plan",
  });
  const summaryLabel = t("orchestrator.planEdit.summary", {
    defaultValue: "Edit summary",
  });
  const draftLabel = t("orchestrator.planEdit.draft", {
    defaultValue: "Plan JSON",
  });
  const baseLabel = t("orchestrator.planEdit.base", {
    defaultValue: "Base revision",
  });
  const currentPlanLabel = t("orchestrator.planEdit.currentPlan", {
    defaultValue: "Current plan",
  });
  const { ref: toggleRef, agentProps: toggleAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "inspector-plan-edit-toggle",
      role: "button",
      label: toggleLabel,
      group: "orchestrator-inspector",
      description: "Open the plan JSON editor",
    });

  useEffect(() => {
    setDraft(planSource);
    setSummary("");
    setError(null);
  }, [planSource]);

  const submit = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      // error-policy:J3 invalid plan JSON becomes an explicit form error.
      setError(
        t("orchestrator.planEdit.invalidJson", {
          defaultValue: "Plan must be valid JSON.",
        }),
      );
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError(
        t("orchestrator.planEdit.invalidObject", {
          defaultValue: "Plan must be a JSON object.",
        }),
      );
      return;
    }
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(
        t("orchestrator.confirmRestartWithPlan", {
          defaultValue:
            "Restart this task with the edited plan? Active agents will be stopped first.",
        }),
      );
    if (!confirmed) return;
    setError(null);
    onSubmit({
      plan: parsed as Record<string, unknown>,
      basePlanRevisionId: latestPlanRevisionId,
      editSummary: summary.trim() || undefined,
      stopActive: true,
    });
  };

  return (
    <InspectorSection
      title={t("orchestrator.planEdit.title", {
        defaultValue: "Plan editor",
      })}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-2xs text-muted">
          <span className="font-semibold text-muted-strong">{baseLabel}</span>
          <span className="ml-1 truncate">
            {latestPlanRevisionId ?? currentPlanLabel}
          </span>
        </div>
        <Button
          unstyled
          ref={toggleRef}
          type="button"
          disabled={busy}
          onClick={() => setOpen((prev) => !prev)}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 px-1 text-2xs font-semibold text-muted transition-colors hover:text-txt disabled:opacity-50"
          data-testid="orchestrator-plan-edit-toggle"
          {...toggleAgentProps}
        >
          {open ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
          {toggleLabel}
        </Button>
      </div>
      {open ? (
        <div className="mt-2 space-y-2">
          <label htmlFor="orchestrator-plan-edit-summary" className="block">
            <FieldLabel>{summaryLabel}</FieldLabel>
            <Input
              id="orchestrator-plan-edit-summary"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              className={FIELD_CLASS}
              placeholder={t("orchestrator.planEdit.summaryPlaceholder", {
                defaultValue: "What changed",
              })}
              data-testid="orchestrator-plan-edit-summary"
            />
          </label>
          <label htmlFor="orchestrator-plan-draft" className="block">
            <FieldLabel>{draftLabel}</FieldLabel>
            <Textarea
              id="orchestrator-plan-draft"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={8}
              className={`${FIELD_CLASS} resize-y font-mono leading-relaxed`}
              spellCheck={false}
              data-testid="orchestrator-plan-draft"
            />
          </label>
          {error ? <p className="text-2xs text-danger">{error}</p> : null}
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={submit}
              className="h-7 gap-1.5 px-2.5 text-xs-tight"
              data-testid="orchestrator-plan-restart"
              data-agent-authority="human"
              data-agent-human-id="inspector-restart-edited-plan"
            >
              <RotateCcw className="h-3 w-3" />
              {restartLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </InspectorSection>
  );
}

function AcceptanceSection({
  criteria,
  t,
}: {
  criteria: string[];
  t: Translate;
}) {
  return (
    <InspectorSection
      title={t("orchestrator.acceptance", { defaultValue: "Acceptance" })}
    >
      <ul className="space-y-1">
        {criteria.map((criterion, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: criteria strings may repeat, so index disambiguates the composite key
            key={`${criterion}-${index}`}
            className="flex items-start gap-1.5 text-xs-tight text-txt"
          >
            <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent/60" />
            <span>{criterion}</span>
          </li>
        ))}
      </ul>
    </InspectorSection>
  );
}

function ArtifactSection({
  artifacts,
  t,
}: {
  artifacts: CodingAgentTaskArtifactRecord[];
  t: Translate;
}) {
  return (
    <InspectorSection
      title={t("orchestrator.artifacts", { defaultValue: "Artifacts" })}
    >
      <div className="space-y-1.5">
        {artifacts.map((artifact) => (
          <div key={artifact.id} className="text-xs-tight">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-medium text-txt">
                {artifact.title}
              </span>
              <VerificationGlyph status={artifact.verificationStatus} t={t} />
            </div>
            <div className="truncate text-muted">
              {artifact.artifactType}
              {artifact.path || artifact.uri
                ? ` · ${artifact.path ?? artifact.uri}`
                : ""}
            </div>
          </div>
        ))}
      </div>
    </InspectorSection>
  );
}

export function UsageSection({
  usage,
  t,
  locale,
}: {
  usage: CodingAgentTaskUsageSummary;
  t: Translate;
  locale?: string;
}) {
  return (
    <InspectorSection
      title={t("orchestrator.usage.title", { defaultValue: "Tokens & cost" })}
    >
      <div className="mb-2 flex items-center gap-3 text-xs">
        <span className="text-txt">
          <span className="font-semibold tabular-nums">
            {renderTokens(usage, t, locale)}
          </span>{" "}
          <span className="text-muted">
            {t("orchestrator.usage.tokens", { defaultValue: "tokens" })}
          </span>
        </span>
        <span className="text-txt">
          <span className="font-semibold tabular-nums">
            {renderCost(usage, t, locale)}
          </span>
        </span>
      </div>
      {usage.byProvider.length > 1 ? (
        <div className="space-y-1">
          {usage.byProvider.map((entry) => (
            <div
              key={`${entry.provider}-${entry.model ?? "default"}`}
              className="flex items-center gap-2 text-2xs text-muted"
            >
              <span className="min-w-0 flex-1 truncate">
                {entry.provider}
                {entry.model ? ` · ${entry.model}` : ""}
              </span>
              <span className="shrink-0 tabular-nums">
                {formatTokenCount(entry.state, entry.totalTokens, t, locale)}
              </span>
              <span className="shrink-0 tabular-nums">
                {entry.state === "unavailable"
                  ? t("orchestrator.usage.unavailable", { defaultValue: "—" })
                  : formatUsd(entry.costUsd, locale)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </InspectorSection>
  );
}

const FIELD_CLASS =
  "w-full border-border/35 border-b bg-transparent px-1 py-1.5 text-xs text-txt outline-none transition-colors placeholder:text-muted focus:border-accent/60";

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1 block text-xs font-medium text-muted">
      {children}
    </span>
  );
}

function AddAgentForm({
  busy,
  onClose,
  onSubmit,
  t,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: CodingAgentAddAgentInput) => void;
  t: Translate;
}) {
  const [label, setLabel] = useState("");
  const [framework, setFramework] = useState("");
  const [model, setModel] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [repo, setRepo] = useState("");
  const [task, setTask] = useState("");

  const fieldLabels = {
    label: t("orchestrator.addAgent.label", {
      defaultValue: "Label (optional)",
    }),
    framework: t("orchestrator.addAgent.framework", {
      defaultValue: "Framework",
    }),
    model: t("orchestrator.addAgent.model", { defaultValue: "Model" }),
    workdir: t("orchestrator.addAgent.workdir", {
      defaultValue: "Workdir (optional)",
    }),
    repo: t("orchestrator.addAgent.repo", {
      defaultValue: "Repo URL (optional)",
    }),
    task: t("orchestrator.addAgent.task", {
      defaultValue: "Sub-task for this agent (optional)",
    }),
  };
  const spawnLabel = t("orchestrator.action.spawn", {
    defaultValue: "Spawn agent",
  });
  const cancelLabel = t("orchestrator.action.cancel", {
    defaultValue: "Cancel",
  });
  const spawn = () =>
    onSubmit({
      label: label.trim() || undefined,
      framework: framework.trim() || undefined,
      model: model.trim() || undefined,
      workdir: workdir.trim() || undefined,
      repo: repo.trim() || undefined,
      task: task.trim() || undefined,
    });
  const { ref: labelRef, agentProps: labelAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "add-agent-label",
      role: "text-input",
      label: fieldLabels.label,
      group: "orchestrator-add-agent",
      description: "Optional label for the spawned sub-agent",
      getValue: () => label,
      onFill: (value) => setLabel(value),
    });
  const { ref: frameworkRef, agentProps: frameworkAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "add-agent-framework",
      role: "text-input",
      label: fieldLabels.framework,
      group: "orchestrator-add-agent",
      description: "Coding-agent framework for the sub-agent",
      getValue: () => framework,
      onFill: (value) => setFramework(value),
    });
  const { ref: modelRef, agentProps: modelAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "add-agent-model",
      role: "text-input",
      label: fieldLabels.model,
      group: "orchestrator-add-agent",
      description: "Model for the sub-agent",
      getValue: () => model,
      onFill: (value) => setModel(value),
    });
  const { ref: workdirRef, agentProps: workdirAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "add-agent-workdir",
      role: "text-input",
      label: fieldLabels.workdir,
      group: "orchestrator-add-agent",
      description: "Optional working directory for the sub-agent",
      getValue: () => workdir,
      onFill: (value) => setWorkdir(value),
    });
  const { ref: repoRef, agentProps: repoAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "add-agent-repo",
      role: "text-input",
      label: fieldLabels.repo,
      group: "orchestrator-add-agent",
      description: "Optional repo URL for the sub-agent",
      getValue: () => repo,
      onFill: (value) => setRepo(value),
    });
  const { ref: taskRef, agentProps: taskAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: "add-agent-task",
      role: "textarea",
      label: fieldLabels.task,
      group: "orchestrator-add-agent",
      description: "Optional sub-task description for the sub-agent",
      getValue: () => task,
      onFill: (value) => setTask(value),
    });
  const { ref: cancelRef, agentProps: cancelAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "add-agent-cancel",
      role: "button",
      label: cancelLabel,
      group: "orchestrator-add-agent",
      description: "Cancel adding a sub-agent",
    });

  return (
    <div className="mt-1.5 space-y-1.5">
      <Input
        ref={labelRef}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        className={FIELD_CLASS}
        placeholder={fieldLabels.label}
        aria-label={fieldLabels.label}
        data-testid="orchestrator-add-agent-label"
        {...labelAgentProps}
      />
      <div className="flex gap-1.5">
        <Input
          ref={frameworkRef}
          value={framework}
          onChange={(event) => setFramework(event.target.value)}
          className={FIELD_CLASS}
          placeholder={fieldLabels.framework}
          aria-label={fieldLabels.framework}
          {...frameworkAgentProps}
        />
        <Input
          ref={modelRef}
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className={FIELD_CLASS}
          placeholder={fieldLabels.model}
          aria-label={fieldLabels.model}
          {...modelAgentProps}
        />
      </div>
      <Input
        ref={workdirRef}
        value={workdir}
        onChange={(event) => setWorkdir(event.target.value)}
        className={FIELD_CLASS}
        placeholder={fieldLabels.workdir}
        aria-label={fieldLabels.workdir}
        {...workdirAgentProps}
      />
      <Input
        ref={repoRef}
        value={repo}
        onChange={(event) => setRepo(event.target.value)}
        className={FIELD_CLASS}
        placeholder={fieldLabels.repo}
        aria-label={fieldLabels.repo}
        {...repoAgentProps}
      />
      <Textarea
        ref={taskRef}
        value={task}
        onChange={(event) => setTask(event.target.value)}
        rows={2}
        className={`${FIELD_CLASS} resize-none`}
        placeholder={fieldLabels.task}
        aria-label={fieldLabels.task}
        {...taskAgentProps}
      />
      <div className="flex justify-end gap-2">
        <Button
          ref={cancelRef}
          variant="secondary"
          size="sm"
          onClick={onClose}
          className="h-6 px-2 text-2xs"
          {...cancelAgentProps}
        >
          {cancelLabel}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={spawn}
          className="h-6 px-2 text-2xs"
          data-testid="orchestrator-add-agent-submit"
          data-agent-authority="human"
          data-agent-human-id="add-agent-spawn"
        >
          {spawnLabel}
        </Button>
      </div>
    </div>
  );
}

function ControlButton({
  agentId,
  description,
  icon,
  label,
  onClick,
  disabled,
  tone = "neutral",
  testId,
}: {
  agentId: string;
  description: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  tone?: "neutral" | "danger";
  testId?: string;
}) {
  return (
    <Button
      unstyled
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex items-center justify-center p-1.5 transition-colors disabled:opacity-50 ${
        tone === "danger"
          ? "text-muted hover:text-danger"
          : "text-muted hover:text-txt"
      }`}
      data-testid={testId}
      data-agent-authority="human"
      data-agent-human-id={agentId}
      data-agent-human-reason={description}
    >
      {icon}
    </Button>
  );
}

function AgentLocalControlButton({
  agentId,
  description,
  icon,
  label,
  onClick,
  disabled,
  testId,
}: {
  agentId: string;
  description: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  testId?: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group: "orchestrator-inspector",
    description,
  });
  return (
    <Button
      unstyled
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex items-center justify-center p-1.5 text-muted transition-colors hover:text-txt disabled:opacity-50"
      data-testid={testId}
      {...agentProps}
    >
      {icon}
    </Button>
  );
}

export function RecoveryActionButton({
  agentId,
  description,
  icon,
  label,
  onClick,
  disabled,
  testId,
}: {
  agentId: string;
  description: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <Button
      unstyled
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 px-1 text-2xs font-semibold text-muted transition-colors hover:text-txt disabled:opacity-50"
      data-testid={testId}
      data-agent-authority="human"
      data-agent-human-id={agentId}
      data-agent-human-reason={description}
    >
      {icon}
      {label}
    </Button>
  );
}

function AgentDeleteDialogCancel({ label }: { label: string }) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "inspector-delete-cancel",
    role: "button",
    label,
    group: "orchestrator-inspector-delete-confirmation",
    description: "Cancel deleting this task",
  });
  return (
    <AlertDialogCancel ref={ref} {...agentProps}>
      {label}
    </AlertDialogCancel>
  );
}

function AgentDeleteDialogConfirm({
  label,
  onDelete,
}: {
  label: string;
  onDelete: () => void;
}) {
  return (
    <AlertDialogAction
      onClick={onDelete}
      className="bg-red-600 hover:bg-red-700"
      data-agent-authority="human"
      data-agent-human-id="inspector-delete-confirm"
    >
      {label}
    </AlertDialogAction>
  );
}

export function TaskInspector({
  detail,
  className,
  style,
  onClose,
  busy,
  addAgentOpen,
  onPause,
  onResume,
  onArchive,
  onReopen,
  onDelete,
  onFork,
  onRestart,
  onRestartWithEditedPlan,
  onValidate,
  onSetPriority,
  onToggleAddAgent,
  onAddAgent,
  onInspectSession,
  onStopAgent,
  onCopyLink,
  t,
  locale,
}: {
  detail: CodingAgentTaskThreadDetail;
  className?: string;
  style?: CSSProperties;
  onClose?: () => void;
  busy: boolean;
  addAgentOpen: boolean;
  onPause: () => void;
  onResume: () => void;
  onArchive: () => void;
  onReopen: () => void;
  onDelete: () => void;
  onFork: () => void;
  onRestart: () => void;
  onRestartWithEditedPlan: (
    input: CodingAgentRestartWithEditedPlanInput,
  ) => void;
  onValidate: (passed: boolean) => void;
  onSetPriority: (priority: TaskPriority) => void;
  onToggleAddAgent: () => void;
  onAddAgent: (input: CodingAgentAddAgentInput) => void;
  onInspectSession: (sessionId: string) => void;
  onStopAgent: (sessionId: string) => void;
  onCopyLink: () => void;
  t: Translate;
  locale?: string;
}) {
  const plan = normalizePlan(detail.currentPlan);
  const sessions = [...detail.sessions].sort((a, b) => {
    const bTime =
      typeof b.lastActivityAt === "number" && Number.isFinite(b.lastActivityAt)
        ? b.lastActivityAt
        : 0;
    const aTime =
      typeof a.lastActivityAt === "number" && Number.isFinite(a.lastActivityAt)
        ? a.lastActivityAt
        : 0;
    return bTime - aTime || a.id.localeCompare(b.id);
  });
  // The real git change set the latest sub-agent produced, mirrored onto its
  // session record's metadata at task_complete and served by the existing
  // task-detail route. Read-only review surface; absent for in-flight or
  // no-op completions.
  const latestChangeSet = sessions
    .map((session) => readSessionChangeSet(session.metadata))
    .find((value): value is ChangeSetData => value !== undefined);
  const artifacts = [...detail.artifacts].reverse().slice(0, 12);
  const latestPlanRevisionId =
    detail.planRevisions.length > 0
      ? detail.planRevisions[detail.planRevisions.length - 1]?.id
      : undefined;
  const archived = detail.status === "archived";
  const terminal = TERMINAL_TASK_STATUSES.has(detail.status);
  const providerPolicyLine = detail.providerPolicy
    ? [
        detail.providerPolicy.preferredFramework,
        detail.providerPolicy.providerSource,
        detail.providerPolicy.model,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ")
    : "";
  const closeDetailsLabel = t("orchestrator.action.closeDetails", {
    defaultValue: "Close details",
  });
  const setPriorityLabel = t("orchestrator.action.setPriority", {
    defaultValue: "Set priority",
  });
  const { ref: closeRef, agentProps: closeAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "inspector-close",
      role: "button",
      label: closeDetailsLabel,
      group: "orchestrator-inspector",
      description: "Close the task details panel",
      clickable: Boolean(onClose),
    });

  return (
    <div
      className={`shrink-0 flex-col gap-4 overflow-y-auto bg-bg p-3 ${className ?? "flex w-80"}`}
      style={style}
      data-testid="orchestrator-inspector"
    >
      {onClose ? (
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium text-muted">
            {t("orchestrator.inspector.title", { defaultValue: "Details" })}
          </h3>
          <Button
            unstyled
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="-mr-1 p-1 text-muted transition-colors hover:text-txt"
            aria-label={closeDetailsLabel}
            data-testid="orchestrator-close-inspector"
            {...closeAgentProps}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {detail.status === "validating" ? (
          <>
            <ControlButton
              agentId="inspector-approve"
              description="Approve the task validation"
              icon={<Check className="h-3 w-3" />}
              label={t("orchestrator.action.approve", {
                defaultValue: "Approve",
              })}
              onClick={() => onValidate(true)}
              disabled={busy}
              testId="orchestrator-approve"
            />
            <ControlButton
              agentId="inspector-reject"
              description="Reject the task validation"
              icon={<X className="h-3 w-3" />}
              label={t("orchestrator.action.reject", {
                defaultValue: "Reject",
              })}
              onClick={() => onValidate(false)}
              disabled={busy}
              tone="danger"
              testId="orchestrator-reject"
            />
          </>
        ) : null}
        {archived ? (
          <ControlButton
            agentId="inspector-reopen"
            description="Reopen this archived task"
            icon={<RotateCcw className="h-3 w-3" />}
            label={t("orchestrator.action.reopen", { defaultValue: "Reopen" })}
            onClick={onReopen}
            disabled={busy}
            testId="orchestrator-reopen"
          />
        ) : terminal ? null : detail.paused ? (
          <ControlButton
            agentId="inspector-resume"
            description="Resume this paused task"
            icon={<Play className="h-3 w-3" />}
            label={t("orchestrator.action.resume", { defaultValue: "Resume" })}
            onClick={onResume}
            disabled={busy}
            testId="orchestrator-inspector-resume"
          />
        ) : (
          <ControlButton
            agentId="inspector-pause"
            description="Pause this task"
            icon={<Pause className="h-3 w-3" />}
            label={t("orchestrator.action.pause", { defaultValue: "Pause" })}
            onClick={onPause}
            disabled={busy}
            testId="orchestrator-inspector-pause"
          />
        )}
        {archived ? null : (
          <ControlButton
            agentId="inspector-archive"
            description="Archive this task"
            icon={<Archive className="h-3 w-3" />}
            label={t("orchestrator.action.archive", {
              defaultValue: "Archive",
            })}
            onClick={onArchive}
            disabled={busy}
            testId="orchestrator-inspector-archive"
          />
        )}
        {terminal ? null : (
          <ControlButton
            agentId="inspector-fork"
            description="Fork this task into a new task"
            icon={<GitFork className="h-3 w-3" />}
            label={t("orchestrator.action.fork", { defaultValue: "Fork" })}
            onClick={onFork}
            disabled={busy}
            testId="orchestrator-fork"
          />
        )}
        {terminal ? null : (
          <ControlButton
            agentId="inspector-restart"
            description="Restart this task with a fresh worker"
            icon={<RotateCcw className="h-3 w-3" />}
            label={t("orchestrator.action.restart", {
              defaultValue: "Restart",
            })}
            onClick={onRestart}
            disabled={busy}
            testId="orchestrator-inspector-restart"
          />
        )}
        {terminal ? null : (
          <AgentLocalControlButton
            agentId="inspector-add-agent"
            description="Open the add-agent form for this task"
            icon={<UserPlus className="h-3 w-3" />}
            label={t("orchestrator.action.addAgent", {
              defaultValue: "Add agent",
            })}
            onClick={onToggleAddAgent}
            disabled={busy}
            testId="orchestrator-add-agent"
          />
        )}
        <AgentLocalControlButton
          agentId="inspector-copy-link"
          description="Copy a deep link to this task"
          icon={<Copy className="h-3 w-3" />}
          label={t("orchestrator.action.copyLink", {
            defaultValue: "Copy link",
          })}
          onClick={onCopyLink}
          disabled={busy}
          testId="orchestrator-copy-link"
        />
        {terminal ? null : (
          <Select
            value={detail.priority}
            onValueChange={(value) => {
              const next = paramPriority(value);
              if (next && next !== detail.priority) onSetPriority(next);
            }}
            disabled={busy}
          >
            <SelectTrigger
              aria-label={setPriorityLabel}
              className="border-border/35 h-auto w-auto border-b bg-transparent px-1 py-1 text-2xs text-muted transition-colors hover:border-accent/60 hover:text-txt disabled:opacity-50"
              data-testid="orchestrator-priority-select"
              data-agent-authority="human"
              data-agent-human-id="inspector-priority"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">{labelPriority("low", t)}</SelectItem>
              <SelectItem value="normal">
                {labelPriority("normal", t)}
              </SelectItem>
              <SelectItem value="high">{labelPriority("high", t)}</SelectItem>
              <SelectItem value="urgent">
                {labelPriority("urgent", t)}
              </SelectItem>
            </SelectContent>
          </Select>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <ControlButton
              agentId="inspector-delete"
              description="Delete this task"
              icon={<Trash2 className="h-3 w-3" />}
              label={t("orchestrator.action.delete", {
                defaultValue: "Delete",
              })}
              onClick={() => {}}
              disabled={busy}
              tone="danger"
              testId="orchestrator-delete"
            />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("orchestrator.confirmDeleteTitle", {
                  defaultValue: "Delete task?",
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("orchestrator.confirmDelete", {
                  defaultValue:
                    "Delete this task and its transcript? This can't be undone.",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AgentDeleteDialogCancel
                label={t("orchestrator.action.cancel", {
                  defaultValue: "Cancel",
                })}
              />
              <AgentDeleteDialogConfirm
                label={t("orchestrator.action.delete", {
                  defaultValue: "Delete",
                })}
                onDelete={onDelete}
              />
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {addAgentOpen && !terminal ? (
        <AddAgentForm
          busy={busy}
          onClose={onToggleAddAgent}
          onSubmit={onAddAgent}
          t={t}
        />
      ) : null}

      <InspectorSection
        title={t("orchestrator.goal", { defaultValue: "Goal" })}
      >
        <p className="whitespace-pre-wrap text-xs-tight text-txt">
          {detail.goal || detail.originalRequest}
        </p>
        {detail.parentTaskId ? (
          <p className="mt-1.5 text-2xs text-muted">
            {t("orchestrator.forkedFrom", {
              defaultValue: "Forked from {{id}}",
              id: detail.parentTaskId,
            })}
          </p>
        ) : null}
      </InspectorSection>

      <InspectorSection
        title={t("orchestrator.subAgents", { defaultValue: "Sub-agents" })}
      >
        {sessions.length === 0 ? (
          <p className="text-xs-tight text-muted">
            {t("orchestrator.noSubAgents", {
              defaultValue: "No sub-agents spawned yet.",
            })}
          </p>
        ) : (
          <div className="space-y-1.5">
            {sessions.map((session) => (
              <SubAgentCard
                key={session.id}
                session={session}
                busy={busy}
                onInspect={onInspectSession}
                onStop={onStopAgent}
                t={t}
                locale={locale}
              />
            ))}
          </div>
        )}
      </InspectorSection>

      {latestChangeSet ? (
        <InspectorSection
          title={t("orchestrator.changes", { defaultValue: "Changes" })}
        >
          <DiffReviewPanel changeSet={latestChangeSet} />
        </InspectorSection>
      ) : null}

      {plan ? <PlanSection plan={plan} t={t} /> : null}
      {detail.currentPlan && !terminal ? (
        <EditedPlanRestartSection
          plan={detail.currentPlan}
          latestPlanRevisionId={latestPlanRevisionId}
          busy={busy}
          onSubmit={onRestartWithEditedPlan}
          t={t}
        />
      ) : null}
      {detail.acceptanceCriteria.length > 0 ? (
        <AcceptanceSection criteria={detail.acceptanceCriteria} t={t} />
      ) : null}
      {artifacts.length > 0 ? (
        <ArtifactSection artifacts={artifacts} t={t} />
      ) : null}
      <UsageSection usage={detail.usage} t={t} locale={locale} />

      {providerPolicyLine ? (
        <InspectorSection
          title={t("orchestrator.providerPolicy", {
            defaultValue: "Provider policy",
          })}
        >
          <p className="text-xs-tight text-txt">{providerPolicyLine}</p>
        </InspectorSection>
      ) : null}
    </div>
  );
}

export function compactText(value: string, max = 6000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}\n\n… ${(
    value.length - max
  ).toLocaleString()} characters truncated`;
}

export function hasRecordEntries(
  value: Record<string, unknown> | null | undefined,
) {
  return Boolean(value && Object.keys(value).length > 0);
}

/**
 * Validate a captured change set off a session record's metadata. The orchestrator
 * mirrors its `WorkspaceChangeSet` onto `metadata.lastChangeSet`; guard the shape
 * here so a malformed value never reaches the read-only diff panel.
 */
function readSessionChangeSet(
  metadata: Record<string, unknown>,
): ChangeSetData | undefined {
  const raw = metadata.lastChangeSet;
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<ChangeSetData>;
  if (!Array.isArray(candidate.changedFiles)) return undefined;
  if (typeof candidate.diff !== "string") return undefined;
  if (typeof candidate.diffStat !== "string") return undefined;
  if (typeof candidate.truncated !== "boolean") return undefined;
  if (typeof candidate.capturedAt !== "number") return undefined;
  return candidate as ChangeSetData;
}
