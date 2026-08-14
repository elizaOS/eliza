/**
 * Native Smithers workflow studio for source authoring, visual structure,
 * widgets, revisions, and live run inspection through elizaOS Cloud APIs.
 */
import {
  Activity,
  ArchiveRestore,
  Bot,
  Braces,
  Check,
  CircleStop,
  Clock3,
  FileInput,
  FileOutput,
  GitBranch,
  History,
  LayoutDashboard,
  ListTree,
  MessageSquareText,
  Play,
  RefreshCw,
  Save,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";
import type {
  WorkflowDefinition,
  WorkflowDefinitionWriteRequest,
  WorkflowExecution,
  WorkflowRevision,
  WorkflowStepManifest,
  WorkflowWidgetManifest,
} from "../../api/client-types-chat";
import { dispatchChatPrefill } from "../../events";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

type StudioTab = "build" | "source" | "runs" | "widgets" | "history";

const EMPTY_SOURCE = `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";

const { Workflow, Task, smithers, outputs } = createSmithers(
  { result: z.object({ message: z.string() }) },
  { dbPath: process.env.ELIZA_SMTHRS_DB_PATH },
);

const agent = globalThis.__elizaSmithers.agent;

export default smithers(() => (
  <Workflow name="New workflow">
    <Task id="run" output={outputs.result} agent={agent}>
      Complete the requested workflow and return a concise result.
    </Task>
  </Workflow>
));`;

function newWorkflow(): WorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: "",
    name: "New workflow",
    description: "",
    active: false,
    language: "tsx",
    source: EMPTY_SOURCE,
    steps: [{ id: "run", label: "Run", kind: "task", agent: "elizaOS" }],
    widgets: [],
    versionId: "",
    createdAt: now,
    updatedAt: now,
  };
}

function terminal(status: WorkflowExecution["status"]): boolean {
  return ["cancelled", "continued", "failed", "finished"].includes(status);
}

function statusDot(status: WorkflowExecution["status"]): string {
  if (status === "finished") return "bg-emerald-500";
  if (status === "failed" || status === "cancelled") return "bg-destructive";
  if (status.startsWith("waiting")) return "bg-amber-500";
  return "bg-primary";
}

function pretty(value: unknown): string {
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasObjectValues(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object" && Object.keys(value).length > 0,
  );
}

function StepIcon({ kind }: { kind: WorkflowStepManifest["kind"] }) {
  if (kind === "branch") return <GitBranch className="h-4 w-4" />;
  if (kind === "approval") return <Check className="h-4 w-4" />;
  if (kind === "timer") return <Clock3 className="h-4 w-4" />;
  if (kind === "ui") return <LayoutDashboard className="h-4 w-4" />;
  return <Bot className="h-4 w-4" />;
}

function SmithersCanvas({
  steps,
  execution,
}: {
  steps: WorkflowStepManifest[];
  execution: WorkflowExecution | null;
}) {
  const eventTypes = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of execution?.events ?? []) {
      if (event.nodeId) map.set(event.nodeId, event.type);
    }
    return map;
  }, [execution]);
  if (steps.length === 0) {
    return (
      <div
        className="grid h-full min-h-64 place-items-center rounded-xl bg-muted/10"
        title="No visual steps"
      >
        <WorkflowIcon className="h-8 w-8 text-muted-foreground/50" />
        <span className="sr-only">No visual steps</span>
      </div>
    );
  }
  return (
    <div
      data-testid="smithers-canvas"
      className="min-h-0 overflow-auto bg-[radial-gradient(circle_at_1px_1px,hsl(var(--border)/0.38)_1px,transparent_0)] bg-[size:20px_20px] p-5"
    >
      <div className="mx-auto flex w-full max-w-xl flex-col items-center">
        {steps.map((step, index) => {
          const eventType = eventTypes.get(step.id);
          const active = Boolean(
            eventType && !/finish|complete|fail/i.test(eventType),
          );
          const failed = Boolean(eventType && /fail|error/i.test(eventType));
          return (
            <div key={step.id} className="contents">
              {index > 0 ? <div className="h-7 w-px bg-border" /> : null}
              <div
                className={`w-fit min-w-44 max-w-full rounded-xl border bg-card p-3 shadow-sm transition ${active ? "border-primary shadow-[0_0_0_2px_hsl(var(--primary)/0.12)]" : failed ? "border-destructive/60" : "border-border/60"}`}
                title={[
                  step.kind,
                  step.agent,
                  step.description,
                  step.dependsOn?.length
                    ? `After ${step.dependsOn.join(", ")}`
                    : null,
                  eventType,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <StepIcon kind={step.kind} />
                  </div>
                  <p className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {step.label}
                  </p>
                  {eventType ? (
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${failed ? "bg-destructive" : active ? "animate-pulse bg-primary" : "bg-emerald-500"}`}
                    >
                      <span className="sr-only">{eventType}</span>
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorkflowWidget({
  widget,
  output,
  runId,
}: {
  widget: WorkflowWidgetManifest;
  output: unknown;
  runId?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold" title={widget.description}>
          {widget.title}
        </p>
        <span
          className="mt-1 h-2.5 w-2.5 rounded-full bg-primary"
          title={widget.component}
        >
          <span className="sr-only">{widget.component}</span>
        </span>
      </div>
      <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-muted/40 p-3 text-xs leading-relaxed">
        {pretty(output)}
      </pre>
      {widget.actions?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {widget.actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              disabled={!runId || !action.signal}
              variant={action.style === "primary" ? "default" : "outline"}
              onClick={() => {
                if (runId && action.signal)
                  void client.signalWorkflowExecution(runId, action.signal, {
                    actionId: action.id,
                  });
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface WorkflowEditorProps {
  initial?: WorkflowDefinition | null;
  onSaved?: (workflow: WorkflowDefinition) => void;
  onCancel?: () => void;
}

export function WorkflowEditor({
  initial = null,
  onSaved,
  onCancel,
}: WorkflowEditorProps) {
  const [workflow, setWorkflow] = useState<WorkflowDefinition>(
    () => initial ?? newWorkflow(),
  );
  const [tab, setTab] = useState<StudioTab>("build");
  const [scheduleOpen, setScheduleOpen] = useState(Boolean(initial?.schedule));
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<WorkflowRevision[]>([]);

  useEffect(() => {
    setWorkflow(initial ?? newWorkflow());
    setScheduleOpen(Boolean(initial?.schedule));
  }, [initial]);
  const selectedRun =
    executions.find((run) => run.id === selectedRunId) ?? executions[0] ?? null;

  const refreshRuns = useCallback(async () => {
    if (!workflow.id) return;
    const next = await client.getWorkflowExecutions(workflow.id, 30);
    setExecutions(next);
    setSelectedRunId((current) => current ?? next[0]?.id ?? null);
  }, [workflow.id]);

  const refreshRevisions = useCallback(async () => {
    if (!workflow.id) return;
    const next = await client.getWorkflowRevisions(workflow.id, 30);
    setRevisions(next.revisions);
  }, [workflow.id]);

  useEffect(() => {
    void refreshRuns();
    void refreshRevisions();
  }, [refreshRuns, refreshRevisions]);

  useEffect(() => {
    if (!selectedRun || terminal(selectedRun.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const updated = await client.getWorkflowExecution(selectedRun.id);
        setExecutions((current) => [
          updated,
          ...current.filter((run) => run.id !== updated.id),
        ]);
      } catch {
        // error-policy:J4 polling failures leave the last known live state visible.
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [selectedRun]);

  const save = useCallback(async (): Promise<WorkflowDefinition | null> => {
    setSaving(true);
    setError(null);
    try {
      const request: WorkflowDefinitionWriteRequest = {
        name: workflow.name,
        description: workflow.description,
        source: workflow.source,
        language: workflow.language,
        active: workflow.active,
        inputSchema: workflow.inputSchema,
        steps: workflow.steps,
        widgets: workflow.widgets,
        schedule: workflow.schedule,
        metadata: workflow.metadata,
      };
      const saved = workflow.id
        ? await client.updateWorkflowDefinition(workflow.id, request)
        : await client.createWorkflowDefinition(request);
      setWorkflow(saved);
      onSaved?.(saved);
      const next = await client.getWorkflowRevisions(saved.id, 30);
      setRevisions(next.revisions);
      return saved;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to save workflow.",
      );
      return null;
    } finally {
      setSaving(false);
    }
  }, [onSaved, workflow]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const workflowId = workflow.id || (await save())?.id;
      if (!workflowId) return;
      const execution = await client.runWorkflowDefinition(workflowId);
      setExecutions((current) => [
        execution,
        ...current.filter((run) => run.id !== execution.id),
      ]);
      setSelectedRunId(execution.id);
      setTab("runs");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to start workflow.",
      );
    } finally {
      setRunning(false);
    }
  }, [save, workflow.id]);

  const toggleActive = useCallback(async () => {
    if (!workflow.id) return;
    const updated = workflow.active
      ? await client.deactivateWorkflowDefinition(workflow.id)
      : await client.activateWorkflowDefinition(workflow.id);
    setWorkflow(updated);
    onSaved?.(updated);
  }, [onSaved, workflow.active, workflow.id]);

  const openInChat = useCallback(() => {
    dispatchChatPrefill({
      text: workflow.id
        ? `Edit workflow ${workflow.id}: `
        : "Create a Smithers workflow that ",
    });
  }, [workflow.id]);

  return (
    <PagePanel
      data-testid="workflow-studio"
      className="flex min-h-0 flex-1 flex-col overflow-hidden p-0 pb-20"
    >
      <div className="flex items-center gap-1 border-b border-transparent bg-card/70 px-3 py-2 backdrop-blur-sm lg:border-border/70 lg:px-4">
        <Input
          value={workflow.name}
          onChange={(event) =>
            setWorkflow((current) => ({
              ...current,
              name: event.target.value,
            }))
          }
          className="h-8 min-w-20 flex-1 border-0 bg-transparent px-0 text-sm font-semibold shadow-none focus-visible:ring-0 sm:text-base"
          aria-label="Workflow name"
          title={workflow.description || undefined}
        />
        <nav className="flex items-center gap-0.5" aria-label="Workflow views">
          {(
            [
              ["build", "Build", WorkflowIcon],
              ["source", "Source", Braces],
              ["runs", "Runs", Activity],
              ["widgets", "Widgets", LayoutDashboard],
              ["history", "History", History],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`grid h-8 w-8 place-items-center rounded-md transition ${tab === value ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
              aria-label={label}
              aria-current={tab === value ? "page" : undefined}
              title={label}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </nav>
        {workflow.id ? (
          <button
            type="button"
            onClick={() => void toggleActive()}
            className="grid h-8 w-8 place-items-center rounded-md hover:bg-muted/60"
            aria-label={
              workflow.active ? "Disable workflow" : "Enable workflow"
            }
            title={workflow.active ? "Enabled" : "Disabled"}
          >
            <span
              className={`h-2.5 w-2.5 rounded-full ${workflow.active ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
            />
          </button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={openInChat}
          aria-label="Edit with Eliza"
          title="Edit with Eliza"
        >
          <MessageSquareText className="h-4 w-4" />
        </Button>
        <Button
          data-agent-id="save-workflow"
          variant="ghost"
          size="icon-sm"
          onClick={() => void save()}
          disabled={saving}
          aria-label="Save workflow"
          title="Save workflow"
        >
          {saving ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <Save className="h-4 w-4" />
          )}
        </Button>
        <Button
          size="icon-sm"
          onClick={() => void run()}
          disabled={running}
          aria-label="Run"
          title="Run"
        >
          {running ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </Button>
        {onCancel ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onCancel}
            aria-label="Close workflow"
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="mx-4 mt-3 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {tab === "build" ? (
        <div className="min-h-0 flex-1 p-2">
          <SmithersCanvas
            steps={workflow.steps ?? []}
            execution={selectedRun}
          />
        </div>
      ) : null}

      {tab === "source" ? (
        <section className="relative flex min-h-0 flex-1 flex-col p-2 pb-24 lg:pb-2">
          <Textarea
            data-testid="smithers-source-editor"
            value={workflow.source}
            onChange={(event) =>
              setWorkflow((current) => ({
                ...current,
                source: event.target.value,
              }))
            }
            spellCheck={false}
            aria-label="Smithers workflow source"
            className="min-h-[420px] flex-1 resize-none rounded-xl border-0 bg-zinc-950 p-4 font-mono text-[12px] leading-5 text-zinc-100"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute bottom-4 right-4 text-muted-foreground"
            onClick={() => setScheduleOpen((current) => !current)}
            aria-expanded={scheduleOpen}
            aria-label="Schedule"
            title={workflow.schedule?.enabled ? "Scheduled" : "Schedule"}
          >
            <Clock3
              className={`h-4 w-4 ${workflow.schedule?.enabled ? "text-primary" : ""}`}
            />
          </Button>
          {scheduleOpen ? (
            <div className="absolute inset-x-3 bottom-14 grid gap-2 rounded-xl bg-card/95 p-2 shadow-lg backdrop-blur sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Input
                value={workflow.schedule?.cron ?? ""}
                onChange={(event) =>
                  setWorkflow((current) => ({
                    ...current,
                    schedule: {
                      cron: event.target.value,
                      timezone:
                        current.schedule?.timezone ??
                        Intl.DateTimeFormat().resolvedOptions().timeZone,
                      enabled: current.schedule?.enabled ?? false,
                    },
                  }))
                }
                placeholder="Cron schedule (optional)"
                aria-label="Workflow cron schedule"
              />
              <Input
                value={workflow.schedule?.timezone ?? ""}
                onChange={(event) =>
                  setWorkflow((current) => ({
                    ...current,
                    schedule: {
                      cron: current.schedule?.cron ?? "",
                      timezone: event.target.value,
                      enabled: current.schedule?.enabled ?? false,
                    },
                  }))
                }
                placeholder="Timezone"
                aria-label="Workflow schedule timezone"
              />
              <Button
                type="button"
                variant={workflow.schedule?.enabled ? "default" : "outline"}
                size="icon"
                disabled={!workflow.schedule?.cron}
                aria-label={
                  workflow.schedule?.enabled
                    ? "Disable schedule"
                    : "Enable schedule"
                }
                title={
                  workflow.schedule?.enabled
                    ? "Disable schedule"
                    : "Enable schedule"
                }
                onClick={() =>
                  setWorkflow((current) => ({
                    ...current,
                    schedule: {
                      cron: current.schedule?.cron ?? "",
                      timezone:
                        current.schedule?.timezone ??
                        Intl.DateTimeFormat().resolvedOptions().timeZone,
                      enabled: !current.schedule?.enabled,
                    },
                  }))
                }
              >
                <Clock3 className="h-4 w-4" />
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === "runs" ? (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-auto border-b border-border/70 p-2 lg:border-b-0 lg:border-r">
            <div className="flex justify-end">
              <button
                type="button"
                className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                onClick={() => void refreshRuns()}
                aria-label="Refresh runs"
                title="Refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-1">
              {executions.map((execution) => (
                <button
                  type="button"
                  key={execution.id}
                  onClick={() => setSelectedRunId(execution.id)}
                  className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition ${selectedRun?.id === execution.id ? "border-primary/40 bg-primary/5" : "border-transparent hover:bg-muted/50"}`}
                  title={`${execution.status} · ${execution.id}`}
                >
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusDot(execution.status)}`}
                  >
                    <span className="sr-only">{execution.status}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                    {execution.id.slice(0, 12)}
                  </span>
                  <span className="text-[10px] text-muted-foreground/70">
                    {new Date(execution.startedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </button>
              ))}
              {executions.length === 0 ? (
                <div
                  className="grid min-h-32 place-items-center"
                  title="No runs"
                >
                  <Activity className="h-6 w-6 text-muted-foreground/40" />
                  <span className="sr-only">No runs</span>
                </div>
              ) : null}
            </div>
          </aside>
          <section className="min-h-0 overflow-auto p-3">
            {selectedRun ? (
              <div className="mx-auto max-w-4xl space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${statusDot(selectedRun.status)}`}
                    title={selectedRun.status}
                  >
                    <span className="sr-only">{selectedRun.status}</span>
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {selectedRun.id.slice(0, 12)}
                  </span>
                  <div className="flex-1" />
                  {!terminal(selectedRun.status) ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Cancel run"
                      title="Cancel"
                      onClick={() =>
                        void client
                          .cancelWorkflowExecution(selectedRun.id)
                          .then(refreshRuns)
                      }
                    >
                      <CircleStop className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {hasObjectValues(selectedRun.input) ? (
                    <div className="rounded-xl border border-border/60 bg-card p-3">
                      <FileInput
                        className="mb-2 h-4 w-4 text-muted-foreground"
                        aria-label="Input"
                      />
                      <pre className="max-h-64 overflow-auto text-xs">
                        {pretty(selectedRun.input)}
                      </pre>
                    </div>
                  ) : null}
                  <div
                    className={`rounded-xl border border-border/60 bg-card p-3 ${hasObjectValues(selectedRun.input) ? "" : "md:col-span-2"}`}
                  >
                    <FileOutput
                      className="mb-2 h-4 w-4 text-muted-foreground"
                      aria-label="Output"
                    />
                    <pre className="max-h-64 overflow-auto text-xs">
                      {pretty(selectedRun.error ?? selectedRun.output)}
                    </pre>
                  </div>
                </div>
                <div className="rounded-xl border border-border/60 bg-card p-3">
                  <ListTree
                    className="mb-3 h-4 w-4 text-muted-foreground"
                    aria-label="Events"
                  />
                  <div className="space-y-0">
                    {(selectedRun.events ?? []).map((event) => (
                      <div
                        key={event.id}
                        className="grid grid-cols-[22px_70px_minmax(0,1fr)] gap-2 border-l border-border pb-3 text-xs last:pb-0"
                      >
                        <div className="-ml-[5px] mt-1 h-2.5 w-2.5 rounded-full border-2 border-card bg-primary" />
                        <span className="font-mono text-[10px] text-muted-foreground/70">
                          {new Date(event.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                        <div>
                          <p className="font-medium">{event.type}</p>
                          {event.nodeId ? (
                            <p className="mt-0.5 text-muted-foreground">
                              {event.nodeId}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    ))}
                    {(selectedRun.events ?? []).length === 0 ? (
                      <div className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                    ) : null}
                  </div>
                </div>
                {selectedRun.status === "waiting-approval" ? (
                  <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                      <p className="text-sm font-semibold">Approval required</p>
                    </div>
                    <div className="mt-3 flex gap-2">
                      {(() => {
                        const waiting = [...(selectedRun.events ?? [])]
                          .reverse()
                          .find(
                            (event) =>
                              event.nodeId &&
                              /approval|waiting/i.test(event.type),
                          );
                        const nodeId = waiting?.nodeId;
                        if (!nodeId)
                          return (
                            <span className="text-xs text-muted-foreground">
                              Waiting for approval details…
                            </span>
                          );
                        return (
                          <>
                            <Button
                              size="icon-sm"
                              aria-label="Approve"
                              title="Approve"
                              onClick={() =>
                                void client
                                  .decideWorkflowApproval(
                                    selectedRun.id,
                                    nodeId,
                                    waiting.iteration ?? 0,
                                    true,
                                  )
                                  .then(refreshRuns)
                              }
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="outline"
                              aria-label="Deny"
                              title="Deny"
                              onClick={() =>
                                void client
                                  .decideWorkflowApproval(
                                    selectedRun.id,
                                    nodeId,
                                    waiting.iteration ?? 0,
                                    false,
                                  )
                                  .then(refreshRuns)
                              }
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div
                className="grid h-full place-items-center"
                title="Select a run"
              >
                <Activity className="h-7 w-7 text-muted-foreground/40" />
                <span className="sr-only">Select a run</span>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {tab === "widgets" ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
            {(workflow.widgets ?? []).map((widget) => (
              <WorkflowWidget
                key={widget.id}
                widget={widget}
                output={selectedRun?.output}
                runId={selectedRun?.id}
              />
            ))}
            {(workflow.widgets ?? []).length === 0 ? (
              <div
                className="col-span-full grid min-h-72 place-items-center"
                title="No workflow widgets"
              >
                <LayoutDashboard className="h-8 w-8 text-muted-foreground/40" />
                <span className="sr-only">No workflow widgets</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "history" ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mx-auto max-w-3xl space-y-1">
            {revisions.map((revision) => (
              <div
                key={revision.id}
                className="flex items-center gap-3 rounded-lg border border-transparent bg-card px-3 py-2 hover:border-border/60"
                title={revision.operation}
              >
                <div className="grid h-8 w-8 place-items-center rounded-lg bg-muted">
                  <History className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-muted-foreground">
                    {new Date(revision.capturedAt).toLocaleString("en-US")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Restore revision"
                  title="Restore"
                  onClick={() =>
                    void client
                      .restoreWorkflowRevision(workflow.id, revision.versionId)
                      .then((restored) => {
                        setWorkflow(restored);
                        void refreshRevisions();
                      })
                  }
                >
                  <ArchiveRestore className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {revisions.length === 0 ? (
              <div
                className="grid min-h-72 place-items-center"
                title="No saved revisions"
              >
                <History className="h-8 w-8 text-muted-foreground/40" />
                <span className="sr-only">No saved revisions</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </PagePanel>
  );
}
