/**
 * Native Smithers workflow studio for source authoring, visual structure,
 * widgets, revisions, and live run inspection through elizaOS Cloud APIs.
 */
import {
  Activity,
  ArchiveRestore,
  Braces,
  Check,
  ChevronRight,
  CircleStop,
  FileInput,
  FileOutput,
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
  WorkflowWidgetManifest,
} from "../../api/client-types-chat";
import { dispatchChatPrefill } from "../../events";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowTriggerPanel } from "./WorkflowTriggerPanel";

type StudioTab = "build" | "source" | "runs" | "widgets" | "history";

const STUDIO_TABS = [
  ["build", "Build", WorkflowIcon],
  ["source", "Source", Braces],
  ["runs", "Runs", Activity],
  ["widgets", "Widgets", LayoutDashboard],
  ["history", "History", History],
] as const;

const EMPTY_SOURCE = `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";

const { Workflow, Task, smithers, outputs } = createSmithers(
  { output: z.object({ message: z.string() }) },
  { dbPath: process.env.ELIZA_SMTHRS_DB_PATH },
);

const agent = globalThis.__elizaSmithers.agent;

export default smithers(() => (
  <Workflow name="New workflow">
    <Task id="run" output={outputs.output} agent={agent} retries={2}>
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

function dataAtPath(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

interface InputField {
  key: string;
  type: "string" | "number" | "integer" | "boolean";
  title: string;
  required: boolean;
  defaultValue?: unknown;
}

function schemaFields(schema?: Record<string, unknown>): InputField[] {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  return Object.entries(properties).flatMap(([key, raw]) => {
    if (!raw || typeof raw !== "object") return [];
    const property = raw as Record<string, unknown>;
    const type = property.type;
    if (
      !(["string", "number", "integer", "boolean"] as const).includes(
        type as never,
      )
    )
      return [];
    return [
      {
        key,
        type: type as InputField["type"],
        title: typeof property.title === "string" ? property.title : key,
        required: required.has(key),
        defaultValue: property.default,
      },
    ];
  });
}

function hasObjectValues(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object" && Object.keys(value).length > 0,
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
  const value = dataAtPath(output, widget.dataPath);
  const rows = Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          Boolean(row) && typeof row === "object",
      )
    : [];
  const columns = rows.length > 0 ? Object.keys(rows[0]).slice(0, 6) : [];
  const chartValues = rows
    .map((row, index) => ({
      label: String(row.label ?? row.name ?? index + 1),
      value: Number(row.value ?? row.count ?? 0),
    }))
    .filter((item) => Number.isFinite(item.value));
  const chartMax = Math.max(1, ...chartValues.map((item) => item.value));
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
      <div className="mt-4 max-h-72 overflow-auto text-xs leading-relaxed">
        {widget.component === "status" ? (
          <div className="flex items-center gap-2 rounded-lg bg-muted/30 p-3">
            <span
              className={`h-2.5 w-2.5 rounded-full ${value === false || value === "failed" || value === "error" ? "bg-destructive" : "bg-emerald-500"}`}
            />
            <span className="font-medium">
              {typeof value === "string" || typeof value === "number"
                ? String(value)
                : "Ready"}
            </span>
          </div>
        ) : widget.component === "data-table" && columns.length > 0 ? (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column}
                    className="border-b px-2 py-1 text-left font-medium text-muted-foreground"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={String(row.id ?? index)}>
                  {columns.map((column) => (
                    <td
                      key={column}
                      className="border-b border-border/40 px-2 py-1.5"
                    >
                      {String(row[column] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : widget.component === "chart" && chartValues.length > 0 ? (
          <div className="space-y-2">
            {chartValues.map((item) => (
              <div
                key={item.label}
                className="grid grid-cols-[minmax(4rem,auto)_1fr_auto] items-center gap-2"
              >
                <span className="truncate text-muted-foreground">
                  {item.label}
                </span>
                <span className="h-2 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${(item.value / chartMax) * 100}%` }}
                  />
                </span>
                <span className="tabular-nums">{item.value}</span>
              </div>
            ))}
          </div>
        ) : widget.component === "issue-list" && Array.isArray(value) ? (
          <ul className="space-y-1.5">
            {value.map((item) => (
              <li
                key={pretty(item)}
                className="flex gap-2 rounded-lg bg-muted/30 p-2"
              >
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
                <span>{typeof item === "string" ? item : pretty(item)}</span>
              </li>
            ))}
          </ul>
        ) : widget.component === "markdown" && typeof value === "string" ? (
          <div className="whitespace-pre-wrap rounded-lg bg-muted/30 p-3">
            {value}
          </div>
        ) : (
          <pre className="rounded-lg bg-muted/40 p-3">{pretty(value)}</pre>
        )}
      </div>
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
  const [savedVersion, setSavedVersion] = useState(() =>
    JSON.stringify(workflow),
  );
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runInputOpen, setRunInputOpen] = useState(false);
  const [runInput, setRunInput] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<WorkflowRevision[]>([]);
  const [cancelArmedId, setCancelArmedId] = useState<string | null>(null);
  const [restoreArmedId, setRestoreArmedId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  useEffect(() => {
    const next = initial ?? newWorkflow();
    setWorkflow(next);
    setSavedVersion(JSON.stringify(next));
  }, [initial]);
  const inputFields = useMemo(
    () => schemaFields(workflow.inputSchema),
    [workflow.inputSchema],
  );
  const dirty = JSON.stringify(workflow) !== savedVersion;
  const selectedRun =
    executions.find((run) => run.id === selectedRunId) ?? executions[0] ?? null;
  const pendingApproval = selectedRun?.approvals?.find(
    (approval) => approval.status === "pending",
  );

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
      setSavedVersion(JSON.stringify(saved));
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

  const run = useCallback(
    async (input: Record<string, unknown> = {}) => {
      setRunning(true);
      setError(null);
      try {
        const workflowId =
          !workflow.id || dirty ? (await save())?.id : workflow.id;
        if (!workflowId) return;
        const execution = await client.runWorkflowDefinition(workflowId, input);
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
    },
    [dirty, save, workflow.id],
  );

  const requestRun = useCallback(() => {
    if (inputFields.length === 0) {
      void run();
      return;
    }
    setRunInput(
      Object.fromEntries(
        inputFields.flatMap((field) => {
          if (field.defaultValue !== undefined) {
            return [[field.key, field.defaultValue]];
          }
          return field.type === "boolean" && field.required
            ? [[field.key, false]]
            : [];
        }),
      ),
    );
    setRunInputOpen(true);
  }, [inputFields, run]);

  const toggleActive = useCallback(async () => {
    setError(null);
    try {
      const current = dirty ? await save() : workflow;
      if (!current?.id) return;
      const updated = current.active
        ? await client.deactivateWorkflowDefinition(current.id)
        : await client.activateWorkflowDefinition(current.id);
      setWorkflow(updated);
      setSavedVersion(JSON.stringify(updated));
      onSaved?.(updated);
    } catch (cause) {
      // error-policy:J4 activation failures preserve the saved workflow and surface the error.
      setError(
        cause instanceof Error ? cause.message : "Unable to update workflow.",
      );
    }
  }, [dirty, onSaved, save, workflow]);

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
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-0 pb-20"
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-transparent bg-card/90 px-3 py-2 lg:border-border/70 lg:px-4">
        <Input
          value={workflow.name}
          onChange={(event) =>
            setWorkflow((current) => ({
              ...current,
              name: event.target.value,
            }))
          }
          className="h-8 min-w-20 flex-1 border-0 bg-transparent px-0 text-sm font-semibold shadow-none sm:text-base"
          aria-label="Workflow name"
          title={workflow.description || undefined}
        />
        <nav
          className="order-last flex basis-full items-center justify-center gap-2 pt-1 sm:order-none sm:basis-auto sm:gap-0.5 sm:pt-0"
          aria-label="Workflow views"
        >
          {STUDIO_TABS.map(([value, label, Icon]) => (
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
        {dirty ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-primary"
            title="Unsaved changes"
          >
            <span className="sr-only">Unsaved changes</span>
          </span>
        ) : null}
        <Button
          className="hidden sm:inline-flex"
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
          className="hover:bg-accent/85"
          size="icon-sm"
          onClick={requestRun}
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

      <WorkflowTriggerPanel
        workflowId={workflow.id}
        workflowName={workflow.name}
        onNeedsSave={async () =>
          !workflow.id || dirty ? ((await save())?.id ?? null) : workflow.id
        }
      />

      {error ? (
        <div className="mx-4 mt-3 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {tab === "build" ? (
        <div className="min-h-0 flex-1 p-2">
          <WorkflowCanvas
            steps={workflow.steps ?? []}
            execution={selectedRun}
            onAddStep={() =>
              dispatchChatPrefill({
                text: workflow.id
                  ? `Add a step to workflow ${workflow.id}: `
                  : "Create a Smithers workflow with ",
              })
            }
            onEditStep={(step) =>
              dispatchChatPrefill({
                text: `Edit step ${step.id} in workflow ${workflow.id || workflow.name}: `,
              })
            }
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
                      variant={
                        cancelArmedId === selectedRun.id
                          ? "destructive"
                          : "ghost"
                      }
                      size="icon-sm"
                      aria-label={
                        cancelArmedId === selectedRun.id
                          ? "Confirm cancel run"
                          : "Cancel run"
                      }
                      title={
                        cancelArmedId === selectedRun.id ? "Confirm" : "Cancel"
                      }
                      onClick={() => {
                        if (cancelArmedId !== selectedRun.id) {
                          setCancelArmedId(selectedRun.id);
                          return;
                        }
                        setCancelArmedId(null);
                        void client
                          .cancelWorkflowExecution(selectedRun.id)
                          .then(refreshRuns);
                      }}
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
                    {(selectedRun.events ?? []).map((event) => {
                      const inspectable = hasObjectValues(event.payload);
                      const selected = selectedEventId === event.id;
                      return (
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
                          <div className="min-w-0">
                            {inspectable ? (
                              <button
                                type="button"
                                className="flex min-h-11 w-full items-start gap-1 text-left"
                                aria-label={`Inspect ${event.type} event`}
                                aria-expanded={selected}
                                onClick={() =>
                                  setSelectedEventId(selected ? null : event.id)
                                }
                              >
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium">
                                    {event.type}
                                  </span>
                                  {event.nodeId ? (
                                    <span className="mt-0.5 block truncate text-muted-foreground">
                                      {event.nodeId}
                                    </span>
                                  ) : null}
                                </span>
                                <ChevronRight
                                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${selected ? "rotate-90" : ""}`}
                                />
                              </button>
                            ) : (
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">
                                  {event.type}
                                </span>
                                {event.nodeId ? (
                                  <span className="mt-0.5 block truncate text-muted-foreground">
                                    {event.nodeId}
                                  </span>
                                ) : null}
                              </span>
                            )}
                            {selected ? (
                              <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-muted/40 p-2 text-[10px] leading-4">
                                {pretty(event.payload)}
                              </pre>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
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
                    {pendingApproval?.prompt ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {pendingApproval.prompt}
                      </p>
                    ) : null}
                    <div className="mt-3 flex gap-2">
                      {(() => {
                        const fallback = [...(selectedRun.events ?? [])]
                          .reverse()
                          .find(
                            (event) =>
                              event.nodeId &&
                              /approval|waiting/i.test(event.type),
                          );
                        const nodeId =
                          pendingApproval?.nodeId ?? fallback?.nodeId;
                        const iteration =
                          pendingApproval?.iteration ??
                          fallback?.iteration ??
                          0;
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
                                    iteration,
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
                                    iteration,
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
                  variant={restoreArmedId === revision.id ? "default" : "ghost"}
                  size="icon-sm"
                  aria-label={
                    restoreArmedId === revision.id
                      ? "Confirm restore revision"
                      : "Restore revision"
                  }
                  title={restoreArmedId === revision.id ? "Confirm" : "Restore"}
                  onClick={() => {
                    if (restoreArmedId !== revision.id) {
                      setRestoreArmedId(revision.id);
                      return;
                    }
                    setRestoreArmedId(null);
                    void client
                      .restoreWorkflowRevision(workflow.id, revision.versionId)
                      .then((restored) => {
                        setWorkflow(restored);
                        setSavedVersion(JSON.stringify(restored));
                        void refreshRevisions();
                      });
                  }}
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

      {runInputOpen ? (
        <div className="absolute inset-0 z-30 grid place-items-center bg-background/80 p-4">
          <form
            aria-label="Workflow input"
            className="w-full max-w-md rounded-2xl border border-border/60 bg-card p-4 shadow-xl"
            onSubmit={(event) => {
              event.preventDefault();
              setRunInputOpen(false);
              void run(runInput);
            }}
          >
            <div className="mb-3 flex items-center gap-2">
              <FileInput className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold">Input</span>
              <div className="flex-1" />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close input"
                onClick={() => setRunInputOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-2.5">
              {inputFields.map((field) => (
                <label
                  key={field.key}
                  htmlFor={`workflow-input-${field.key}`}
                  className="block"
                >
                  <span className="sr-only">{field.title}</span>
                  {field.type === "boolean" ? (
                    <span className="flex items-center justify-between rounded-lg bg-muted/35 px-3 py-2 text-sm">
                      {field.title}
                      <input
                        id={`workflow-input-${field.key}`}
                        type="checkbox"
                        checked={Boolean(runInput[field.key])}
                        onChange={(event) =>
                          setRunInput((current) => ({
                            ...current,
                            [field.key]: event.target.checked,
                          }))
                        }
                      />
                    </span>
                  ) : (
                    <Input
                      id={`workflow-input-${field.key}`}
                      aria-label={field.title}
                      required={field.required}
                      type={field.type === "string" ? "text" : "number"}
                      step={field.type === "integer" ? 1 : undefined}
                      placeholder={field.title}
                      value={String(runInput[field.key] ?? "")}
                      onChange={(event) =>
                        setRunInput((current) => ({
                          ...current,
                          [field.key]:
                            field.type === "string"
                              ? event.target.value
                              : Number(event.target.value),
                        }))
                      }
                    />
                  )}
                </label>
              ))}
            </div>
            <Button type="submit" className="mt-4 w-full" disabled={running}>
              {running ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              <span className="sr-only">Run workflow</span>
            </Button>
          </form>
        </div>
      ) : null}
    </PagePanel>
  );
}
