/**
 * WorkflowEditor — text-first workflow editing surface.
 *
 * Layout: split-pane on desktop (JSON editor left, React Flow viewer
 * right). On narrow viewports the editor stacks above the viewer.
 *
 * The JSON editor uses the shared Textarea primitive; Monaco / CodeMirror are
 * too heavy for the few hundred lines of JSON a workflow contains, and neither
 * library is currently a dependency of `@elizaos/ui`.
 *
 * Reactivity: `value` is debounced via `useDebouncedValue`; on debounce
 * settle we parse the JSON. Valid → push to the viewer. Invalid → keep
 * the last valid graph rendered and surface the error inline.
 *
 * Toolbar: Format JSON, Save, Activate/Deactivate, Run now. Validation is
 * always-on via the debounced parse above (the status badge shows
 * Valid/Invalid live), so there is no separate manual "Validate" control.
 */

import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Clock3,
  Copy,
  Pause,
  PlayCircle,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Wand2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowRevision,
} from "../../api/client-types-chat";
import { dispatchChatPrefill } from "../../events";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import {
  buildWorkflowExecutionDiagnostics,
  formatWorkflowEngineMetrics,
  getWorkflowExecutionRunRows,
  summarizeWorkflowExecution,
} from "../../utils/workflow-executions";
import {
  parseWorkflowJson,
  toWriteRequest,
  type WorkflowJsonResult,
  workflowToJsonText,
} from "../../utils/workflow-json";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { StatusDot } from "../ui/status-badge";
import { Textarea } from "../ui/textarea";
import { WorkflowGraphViewer } from "./WorkflowGraphViewer";

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
  const [text, setText] = useState(() => workflowToJsonText(initial));
  const debouncedText = useDebouncedValue(text, 250);
  const [lastValidWorkflow, setLastValidWorkflow] =
    useState<WorkflowDefinition | null>(initial);
  const [parseState, setParseState] = useState<WorkflowJsonResult>({
    ok: true,
    workflow: initial ?? {
      id: "draft",
      name: "New workflow",
      active: false,
      nodes: [],
      connections: {},
    },
    settings: {},
  });
  const [persistedWorkflowId, setPersistedWorkflowId] = useState<string | null>(
    () => initial?.id ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [executionsLoading, setExecutionsLoading] = useState(false);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(
    null,
  );
  const [diagnosticsCopying, setDiagnosticsCopying] = useState(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [evaluationSamplesCopying, setEvaluationSamplesCopying] =
    useState(false);
  const [evaluationSamplesCopied, setEvaluationSamplesCopied] = useState(false);
  const [revisions, setRevisions] = useState<WorkflowRevision[]>([]);
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(
    () => initial?.versionId ?? null,
  );
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [revisionsError, setRevisionsError] = useState<string | null>(null);

  useEffect(() => {
    setPersistedWorkflowId(initial?.id ?? null);
    setText(workflowToJsonText(initial));
    setLastValidWorkflow(initial);
    setParseState({
      ok: true,
      workflow: initial ?? {
        id: "draft",
        name: "New workflow",
        active: false,
        nodes: [],
        connections: {},
      },
      settings: {},
    });
    setSaveError(null);
    setExecutionError(null);
    setExecutions([]);
    setSelectedExecutionId(null);
    setDiagnosticsCopying(false);
    setDiagnosticsCopied(false);
    setEvaluationSamplesCopying(false);
    setEvaluationSamplesCopied(false);
    setRevisions([]);
    setCurrentVersionId(initial?.versionId ?? null);
    setRevisionsError(null);
  }, [initial]);

  // Re-parse on debounced text change.
  useEffect(() => {
    const result = parseWorkflowJson(debouncedText);
    setParseState(result);
    if (result.ok) setLastValidWorkflow(result.workflow);
  }, [debouncedText]);

  const isValid = parseState.ok;
  const activeWorkflow = lastValidWorkflow ?? initial;
  const workflowIsActive = activeWorkflow?.active === true;

  const refreshExecutions = useCallback(async () => {
    if (!persistedWorkflowId) {
      setExecutions([]);
      setSelectedExecutionId(null);
      return;
    }
    setExecutionsLoading(true);
    setExecutionError(null);
    try {
      const next = await client.getWorkflowExecutions(persistedWorkflowId, 20);
      setExecutions(next);
      setSelectedExecutionId((current) => current ?? next[0]?.id ?? null);
    } catch (e) {
      setExecutionError(
        e instanceof Error ? e.message : "Failed to load workflow runs.",
      );
    } finally {
      setExecutionsLoading(false);
    }
  }, [persistedWorkflowId]);

  useEffect(() => {
    void refreshExecutions();
  }, [refreshExecutions]);

  const selectedExecution =
    executions.find((execution) => execution.id === selectedExecutionId) ??
    executions[0] ??
    null;

  const loadRevisionsForWorkflow = useCallback(
    async (workflowId: string | null, fallbackVersionId?: string | null) => {
      if (!workflowId) {
        setRevisions([]);
        setCurrentVersionId(fallbackVersionId ?? null);
        return;
      }
      setRevisionsLoading(true);
      setRevisionsError(null);
      try {
        const next = await client.getWorkflowRevisions(workflowId, 10);
        setCurrentVersionId(next.currentVersionId);
        setRevisions(next.revisions);
      } catch (e) {
        setRevisionsError(
          e instanceof Error ? e.message : "Failed to load workflow history.",
        );
      } finally {
        setRevisionsLoading(false);
      }
    },
    [],
  );

  const refreshRevisions = useCallback(async () => {
    if (!persistedWorkflowId) {
      setRevisions([]);
      setCurrentVersionId(lastValidWorkflow?.versionId ?? null);
      return;
    }
    await loadRevisionsForWorkflow(
      persistedWorkflowId,
      lastValidWorkflow?.versionId ?? null,
    );
  }, [
    persistedWorkflowId,
    lastValidWorkflow?.versionId,
    loadRevisionsForWorkflow,
  ]);

  useEffect(() => {
    void refreshRevisions();
  }, [refreshRevisions]);

  const handleFormat = useCallback(() => {
    const result = parseWorkflowJson(text);
    if (result.ok) {
      setText(workflowToJsonText(result.workflow));
    }
  }, [text]);

  const handleSave = useCallback(async () => {
    if (!parseState.ok) {
      const invalid = parseState as Extract<WorkflowJsonResult, { ok: false }>;
      setSaveError(invalid.message);
      return;
    }
    setSaveError(null);
    setSaving(true);
    try {
      const req = toWriteRequest(parseState);
      const saved = persistedWorkflowId
        ? await client.updateWorkflowDefinition(persistedWorkflowId, req)
        : await client.createWorkflowDefinition(req);
      setPersistedWorkflowId(saved.id);
      setCurrentVersionId(saved.versionId ?? null);
      setLastValidWorkflow(saved);
      setText(workflowToJsonText(saved));
      onSaved?.(saved);
      void refreshExecutions();
      void loadRevisionsForWorkflow(saved.id, saved.versionId ?? null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save workflow.");
    } finally {
      setSaving(false);
    }
  }, [
    parseState,
    persistedWorkflowId,
    onSaved,
    refreshExecutions,
    loadRevisionsForWorkflow,
  ]);

  const handleToggleActive = useCallback(async () => {
    if (!persistedWorkflowId) {
      setSaveError("Save the workflow before changing its schedule state.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated = workflowIsActive
        ? await client.deactivateWorkflowDefinition(persistedWorkflowId)
        : await client.activateWorkflowDefinition(persistedWorkflowId);
      setCurrentVersionId(updated.versionId ?? null);
      setLastValidWorkflow(updated);
      setText(workflowToJsonText(updated));
      void refreshRevisions();
    } catch (e) {
      setSaveError(
        e instanceof Error ? e.message : "Failed to update workflow state.",
      );
    } finally {
      setSaving(false);
    }
  }, [persistedWorkflowId, workflowIsActive, refreshRevisions]);

  const handleRunNow = useCallback(async () => {
    if (!persistedWorkflowId) {
      setSaveError("Save the workflow before running it.");
      return;
    }
    setRunning(true);
    setSaveError(null);
    setExecutionError(null);
    try {
      const execution = await client.runWorkflowDefinition(persistedWorkflowId);
      setExecutions((current) => [
        execution,
        ...current.filter((item) => item.id !== execution.id),
      ]);
      setSelectedExecutionId(execution.id);
      setDiagnosticsCopied(false);
      setEvaluationSamplesCopied(false);
    } catch (e) {
      setExecutionError(
        e instanceof Error ? e.message : "Failed to run workflow.",
      );
    } finally {
      setRunning(false);
    }
  }, [persistedWorkflowId]);

  const handleRestoreRevision = useCallback(
    async (versionId: string) => {
      if (!persistedWorkflowId) return;
      setSaving(true);
      setSaveError(null);
      setRevisionsError(null);
      try {
        const restored = await client.restoreWorkflowRevision(
          persistedWorkflowId,
          versionId,
        );
        setCurrentVersionId(restored.versionId ?? null);
        setLastValidWorkflow(restored);
        setText(workflowToJsonText(restored));
        onSaved?.(restored);
        void refreshExecutions();
        void refreshRevisions();
      } catch (e) {
        setRevisionsError(
          e instanceof Error
            ? e.message
            : "Failed to restore workflow version.",
        );
      } finally {
        setSaving(false);
      }
    },
    [persistedWorkflowId, onSaved, refreshExecutions, refreshRevisions],
  );

  const handleCopyDiagnostics = useCallback(async () => {
    if (!selectedExecution) return;
    setDiagnosticsCopying(true);
    setExecutionError(null);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard is not available in this browser.");
      }
      await navigator.clipboard.writeText(
        buildWorkflowExecutionDiagnostics(selectedExecution),
      );
      setDiagnosticsCopied(true);
    } catch (e) {
      setExecutionError(
        e instanceof Error ? e.message : "Failed to copy workflow diagnostics.",
      );
    } finally {
      setDiagnosticsCopying(false);
    }
  }, [selectedExecution]);

  const handleTroubleshootInChat = useCallback(() => {
    if (!selectedExecution) return;
    const workflowId =
      persistedWorkflowId ?? selectedExecution.workflowId ?? "unknown";
    const diagnostics = buildWorkflowExecutionDiagnostics(selectedExecution);
    dispatchChatPrefill({
      text: [
        `Troubleshoot workflow ${workflowId} execution ${selectedExecution.id}.`,
        "",
        diagnostics,
      ].join("\n"),
      select: false,
    });
  }, [persistedWorkflowId, selectedExecution]);

  const handleEditInChat = useCallback(() => {
    const workflowName = lastValidWorkflow?.name ?? "this workflow";
    const workflowId =
      persistedWorkflowId ?? lastValidWorkflow?.id ?? initial?.id ?? "draft";
    const text =
      workflowId === "draft"
        ? "Create a workflow that "
        : `Modify workflow ${workflowId} (${workflowName}). `;
    dispatchChatPrefill({ text, select: false });
  }, [initial?.id, lastValidWorkflow, persistedWorkflowId]);

  const handleCopyEvaluationSamples = useCallback(async () => {
    if (!persistedWorkflowId) return;
    setEvaluationSamplesCopying(true);
    setExecutionError(null);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard is not available in this browser.");
      }
      const suite = await client.getWorkflowEvaluationSamples(
        persistedWorkflowId,
        10,
      );
      if (suite.sampleCount === 0) {
        throw new Error("Run this workflow before copying eval samples.");
      }
      await navigator.clipboard.writeText(suite.jsonl);
      setEvaluationSamplesCopied(true);
    } catch (e) {
      setExecutionError(
        e instanceof Error ? e.message : "Failed to copy eval samples.",
      );
    } finally {
      setEvaluationSamplesCopying(false);
    }
  }, [persistedWorkflowId]);

  const lineErrorBanner = useMemo(() => {
    if (parseState.ok) return null;
    const invalid = parseState as Extract<WorkflowJsonResult, { ok: false }>;
    const where = invalid.line ? ` (line ${invalid.line})` : "";
    return `${invalid.message}${where}`;
  }, [parseState]);

  const selectedExecutionSummary = selectedExecution
    ? summarizeWorkflowExecution(selectedExecution)
    : null;
  const selectedEngineMetrics = selectedExecution
    ? formatWorkflowEngineMetrics(selectedExecution)
    : null;
  const selectedRunRows = selectedExecution
    ? getWorkflowExecutionRunRows(selectedExecution)
    : [];

  const jsonEditor = useAgentElement<HTMLTextAreaElement>({
    id: "workflow-json",
    role: "textarea",
    label: "Workflow JSON",
    group: "workflow-editor",
    description: "The workflow definition as editable JSON.",
    status: isValid ? "active" : "error",
    getValue: () => text,
    onFill: (value) => setText(value),
  });

  const editInChatButton = useAgentElement<HTMLButtonElement>({
    id: "edit-workflow-in-chat",
    role: "button",
    label: "Edit workflow in chat",
    group: "workflow-toolbar",
    description: "Ask the page chat to create or modify this workflow.",
    onActivate: handleEditInChat,
  });

  const formatButton = useAgentElement<HTMLButtonElement>({
    id: "format-json",
    role: "button",
    label: "Format JSON",
    group: "workflow-toolbar",
    description: "Reformat the workflow JSON.",
    onActivate: handleFormat,
  });

  const saveButton = useAgentElement<HTMLButtonElement>({
    id: "save",
    role: "button",
    label: "Save",
    group: "workflow-toolbar",
    description: "Save the workflow definition.",
    status: saving ? "busy" : undefined,
    onActivate: () => void handleSave(),
  });

  const activateButton = useAgentElement<HTMLButtonElement>({
    id: "toggle-active",
    role: "button",
    label: workflowIsActive ? "Deactivate workflow" : "Activate workflow",
    group: "workflow-toolbar",
    description: workflowIsActive
      ? "Pause scheduled workflow runs."
      : "Activate scheduled workflow runs.",
    status: saving ? "busy" : undefined,
    onActivate: () => void handleToggleActive(),
  });

  const runButton = useAgentElement<HTMLButtonElement>({
    id: "run-now",
    role: "button",
    label: "Run workflow now",
    group: "workflow-toolbar",
    description: "Run the saved workflow once and show the execution.",
    status: running ? "busy" : undefined,
    onActivate: () => void handleRunNow(),
  });

  const refreshRunsButton = useAgentElement<HTMLButtonElement>({
    id: "refresh-runs",
    role: "button",
    label: "Refresh workflow runs",
    group: "workflow-executions",
    description: "Reload recent workflow executions.",
    status: executionsLoading ? "busy" : undefined,
    onActivate: () => void refreshExecutions(),
  });

  const copyDiagnosticsButton = useAgentElement<HTMLButtonElement>({
    id: "copy-run-diagnostics",
    role: "button",
    label: "Copy run diagnostics",
    group: "workflow-executions",
    description:
      "Copy the selected workflow run status, node output, and error details.",
    status: diagnosticsCopying
      ? "busy"
      : selectedExecution
        ? "active"
        : "inactive",
    onActivate: () => void handleCopyDiagnostics(),
  });

  const troubleshootRunButton = useAgentElement<HTMLButtonElement>({
    id: "troubleshoot-run-in-chat",
    role: "button",
    label: "Troubleshoot run in chat",
    group: "workflow-executions",
    description: "Send the selected workflow run diagnostics to the page chat.",
    status: selectedExecution ? "active" : "inactive",
    onActivate: handleTroubleshootInChat,
  });

  const copyEvaluationSamplesButton = useAgentElement<HTMLButtonElement>({
    id: "copy-eval-samples",
    role: "button",
    label: "Copy eval samples",
    group: "workflow-executions",
    description:
      "Copy JSONL workflow evaluation samples for Smithers eval and GEPA optimization.",
    status: evaluationSamplesCopying
      ? "busy"
      : persistedWorkflowId && executions.length > 0
        ? "active"
        : "inactive",
    onActivate: () => void handleCopyEvaluationSamples(),
  });

  const closeButton = useAgentElement<HTMLButtonElement>({
    id: "close",
    role: "button",
    label: "Close",
    group: "workflow-toolbar",
    description: "Close the workflow editor.",
    onActivate: () => onCancel?.(),
  });

  return (
    /* Flat — no card/border. The shell owns the page's horizontal padding. */
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto pb-28 lg:overflow-hidden lg:pb-0">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <div className="mr-auto flex items-center gap-2 min-w-0">
          <h2 className="truncate text-base font-semibold tracking-[-0.01em] text-txt">
            {lastValidWorkflow?.name ?? "New workflow"}
          </h2>
          <span
            className={`inline-flex items-center gap-1.5 text-xs ${
              isValid ? "text-ok" : "text-destructive"
            }`}
          >
            <StatusDot tone={isValid ? "success" : "danger"} />
            {isValid ? "Valid" : "Invalid JSON"}
          </span>
        </div>
        <Button
          ref={editInChatButton.ref}
          {...editInChatButton.agentProps}
          variant="outline"
          size="sm"
          onClick={handleEditInChat}
        >
          <ClipboardList className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">Edit in chat</span>
          <span className="sm:hidden">Chat</span>
        </Button>
        <Button
          ref={formatButton.ref}
          {...formatButton.agentProps}
          variant="outline"
          size="sm"
          onClick={handleFormat}
          disabled={!isValid}
        >
          <Wand2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Format JSON
        </Button>
        <Button
          ref={saveButton.ref}
          {...saveButton.agentProps}
          variant="default"
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving || !isValid}
        >
          {saving ? (
            <Spinner className="mr-1.5 h-3.5 w-3.5" />
          ) : (
            <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          )}
          Save
        </Button>
        {persistedWorkflowId && (
          <Button
            ref={activateButton.ref}
            {...activateButton.agentProps}
            variant="outline"
            size="sm"
            onClick={() => void handleToggleActive()}
            disabled={saving}
          >
            {workflowIsActive ? (
              <Pause className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            ) : (
              <Power className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )}
            {workflowIsActive ? "Deactivate" : "Activate"}
          </Button>
        )}
        {persistedWorkflowId && (
          <Button
            ref={runButton.ref}
            {...runButton.agentProps}
            variant="outline"
            size="sm"
            onClick={() => void handleRunNow()}
            disabled={running || saving}
          >
            {running ? (
              <Spinner className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <PlayCircle className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )}
            Run now
          </Button>
        )}
        {onCancel && (
          <Button
            ref={closeButton.ref}
            {...closeButton.agentProps}
            variant="ghost"
            size="sm"
            onClick={onCancel}
          >
            Close
          </Button>
        )}
      </div>

      {(saveError || lineErrorBanner) && (
        <div className="rounded-sm border border-danger/20 bg-danger/10 p-2.5 text-xs text-danger">
          {saveError ?? lineErrorBanner}
        </div>
      )}

      {/* Split pane */}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
        <PagePanel
          variant="inset"
          className="flex min-h-0 flex-col overflow-hidden p-0"
        >
          <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-strong">
            <span className="font-medium text-txt">workflow.json</span>
            <span>{text.split("\n").length} lines</span>
          </div>
          <Textarea
            ref={jsonEditor.ref}
            {...jsonEditor.agentProps}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            data-testid="workflow-editor-json"
            className="min-h-[240px] flex-1 resize-none border-0 bg-transparent p-3 font-mono text-xs leading-relaxed text-txt sm:min-h-[320px]"
          />
        </PagePanel>

        <div className="flex min-h-0 flex-col gap-3">
          <PagePanel
            variant="inset"
            className="flex min-h-[280px] flex-1 flex-col overflow-hidden"
          >
            <div className="px-3 py-2 text-xs font-medium text-txt">Graph</div>
            <div className="flex-1 p-3">
              <WorkflowGraphViewer
                workflow={lastValidWorkflow}
                loading={false}
                isGenerating={false}
                emptyStateHelpText="Draft in chat. Review the graph, runs, and logs here."
              />
            </div>
          </PagePanel>

          <PagePanel
            variant="inset"
            className="flex min-h-[260px] flex-col overflow-hidden"
          >
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="mr-auto min-w-0">
                <div className="text-xs font-medium text-txt">Runs</div>
                <div className="truncate text-2xs text-muted-strong">
                  {persistedWorkflowId
                    ? `${executions.length} recent execution${executions.length === 1 ? "" : "s"}`
                    : "Save before running"}
                </div>
              </div>
              <Button
                ref={copyEvaluationSamplesButton.ref}
                {...copyEvaluationSamplesButton.agentProps}
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-2xs"
                onClick={() => void handleCopyEvaluationSamples()}
                disabled={
                  !persistedWorkflowId ||
                  executions.length === 0 ||
                  evaluationSamplesCopying
                }
                aria-label="Copy eval samples"
              >
                {evaluationSamplesCopying ? (
                  <Spinner className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <ClipboardList className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                )}
                <span className="hidden sm:inline">
                  {evaluationSamplesCopied ? "Copied" : "Copy samples"}
                </span>
              </Button>
              <Button
                ref={refreshRunsButton.ref}
                {...refreshRunsButton.agentProps}
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void refreshExecutions()}
                disabled={!persistedWorkflowId || executionsLoading}
                aria-label="Refresh workflow runs"
              >
                {executionsLoading ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                )}
              </Button>
            </div>
            {executionError && (
              <div className="bg-danger/10 px-3 py-2 text-xs text-danger">
                {executionError}
              </div>
            )}
            <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
              <div className="min-h-[96px] overflow-auto">
                {executions.length === 0 ? (
                  <div className="flex h-full min-h-[96px] items-center px-3 text-xs text-muted-strong">
                    {persistedWorkflowId
                      ? "No runs yet."
                      : "Save the workflow to run it."}
                  </div>
                ) : (
                  <div>
                    {executions.map((execution) => {
                      const summary = summarizeWorkflowExecution(execution);
                      const selected = execution.id === selectedExecution?.id;
                      return (
                        <Button
                          key={execution.id}
                          variant="ghost"
                          className={`flex h-auto w-full min-w-0 items-center justify-start gap-2 whitespace-normal rounded-none px-3 py-2 text-left font-normal hover:bg-bg-accent/50 ${
                            selected ? "bg-bg-accent" : ""
                          }`}
                          onClick={() => {
                            setSelectedExecutionId(execution.id);
                            setDiagnosticsCopied(false);
                          }}
                        >
                          {summary.tone === "success" ? (
                            <CheckCircle2
                              className="h-3.5 w-3.5 shrink-0 text-ok"
                              aria-hidden
                            />
                          ) : summary.tone === "danger" ? (
                            <AlertTriangle
                              className="h-3.5 w-3.5 shrink-0 text-danger"
                              aria-hidden
                            />
                          ) : (
                            <Clock3
                              className="h-3.5 w-3.5 shrink-0 text-muted-strong"
                              aria-hidden
                            />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-txt">
                              {summary.statusLabel}
                            </span>
                            <span className="block truncate text-2xs text-muted-strong">
                              {new Date(execution.startedAt).toLocaleString(
                                "en-US",
                              )}{" "}
                              / {summary.durationLabel}
                            </span>
                          </span>
                        </Button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="min-h-[156px] overflow-auto p-3">
                {!selectedExecution || !selectedExecutionSummary ? (
                  <div className="flex h-full min-h-[128px] items-center text-xs text-muted-strong">
                    Select a run to inspect node output, logs, and errors.
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-txt">
                        <StatusDot tone={selectedExecutionSummary.tone} />
                        {selectedExecutionSummary.statusLabel}
                      </span>
                      <span className="text-2xs text-muted-strong">
                        {selectedExecutionSummary.nodeCount} node
                        {selectedExecutionSummary.nodeCount === 1 ? "" : "s"} /{" "}
                        {selectedExecutionSummary.durationLabel}
                      </span>
                      {selectedEngineMetrics && (
                        <span className="text-2xs text-muted-strong">
                          / {selectedEngineMetrics}
                        </span>
                      )}
                      <Button
                        ref={copyDiagnosticsButton.ref}
                        {...copyDiagnosticsButton.agentProps}
                        variant="ghost"
                        size="sm"
                        className="ml-auto h-7 px-2 text-2xs"
                        onClick={() => void handleCopyDiagnostics()}
                        disabled={!selectedExecution || diagnosticsCopying}
                      >
                        {diagnosticsCopying ? (
                          <Spinner className="mr-1.5 h-3.5 w-3.5" />
                        ) : (
                          <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        )}
                        {diagnosticsCopied ? "Copied" : "Copy diagnostics"}
                      </Button>
                      <Button
                        ref={troubleshootRunButton.ref}
                        {...troubleshootRunButton.agentProps}
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-2xs"
                        aria-label="Troubleshoot run in chat"
                        onClick={handleTroubleshootInChat}
                        disabled={!selectedExecution}
                      >
                        <AlertTriangle
                          className="mr-0 h-3.5 w-3.5 sm:mr-1.5"
                          aria-hidden
                        />
                        <span className="hidden sm:inline">Troubleshoot</span>
                      </Button>
                    </div>
                    {selectedExecutionSummary.error && (
                      <div className="rounded-sm border border-danger/20 bg-danger/10 p-2 text-xs text-danger">
                        {selectedExecutionSummary.error}
                      </div>
                    )}
                    {selectedRunRows.length === 0 ? (
                      <div className="text-xs text-muted-strong">
                        This execution has no node output yet.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {selectedRunRows.map((row) => (
                          <div
                            key={`${row.nodeName}-${row.startTime ?? row.preview}`}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <span
                                className={`inline-flex items-center gap-1.5 text-xs ${
                                  row.status === "error"
                                    ? "text-destructive"
                                    : row.status === "success"
                                      ? "text-ok"
                                      : "text-muted-strong"
                                }`}
                              >
                                <StatusDot
                                  tone={
                                    row.status === "error"
                                      ? "danger"
                                      : row.status === "success"
                                        ? "success"
                                        : "muted"
                                  }
                                />
                                {row.status}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-xs font-medium text-txt">
                                {row.nodeName}
                              </span>
                              <span className="shrink-0 text-2xs text-muted-strong">
                                {row.itemCount} item
                                {row.itemCount === 1 ? "" : "s"}
                              </span>
                            </div>
                            <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-bg-accent/50 p-2 text-2xs leading-relaxed text-muted-strong">
                              {row.error ?? row.preview}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </PagePanel>

          <PagePanel
            variant="inset"
            className="flex min-h-[132px] flex-col overflow-hidden"
          >
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="mr-auto min-w-0">
                <div className="text-xs font-medium text-txt">History</div>
                <div className="truncate text-2xs text-muted-strong">
                  {currentVersionId
                    ? `Current ${currentVersionId.slice(0, 8)}`
                    : "Unsaved draft"}
                </div>
              </div>
            </div>
            {revisionsError && (
              <div className="bg-danger/10 px-3 py-2 text-xs text-danger">
                {revisionsError}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
              {revisionsLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-strong">
                  <Spinner className="h-3.5 w-3.5" />
                  Loading history
                </div>
              ) : revisions.length === 0 ? (
                <div className="text-xs text-muted-strong">
                  Save an edit to create a restorable version.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {revisions.slice(0, 4).map((revision) => (
                    <WorkflowRevisionRow
                      key={revision.id}
                      revision={revision}
                      disabled={!persistedWorkflowId || saving}
                      onRestore={handleRestoreRevision}
                    />
                  ))}
                </div>
              )}
            </div>
          </PagePanel>
        </div>
      </div>
    </div>
  );
}

function WorkflowRevisionRow({
  revision,
  disabled,
  onRestore,
}: {
  revision: WorkflowRevision;
  disabled: boolean;
  onRestore: (versionId: string) => void;
}) {
  const capturedAt = new Date(revision.capturedAt).toLocaleString("en-US");
  const versionLabel = revision.versionId.slice(0, 8);
  const restoreAction = useAgentElement<HTMLButtonElement>({
    id: `restore-workflow-version-${versionLabel}`,
    role: "button",
    label: `Restore ${revision.name}`,
    group: "workflow-history",
    description: `Restore workflow version ${versionLabel} captured after ${revision.operation}.`,
    status: disabled ? "inactive" : "active",
    onActivate: () => onRestore(revision.versionId),
  });

  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-1 text-xs hover:bg-bg-accent/40">
      <div className="min-w-0 flex-1">
        <div className="truncate text-txt">{revision.name}</div>
        <div className="truncate text-2xs text-muted-strong">
          {revision.operation} / {capturedAt} / {versionLabel}
        </div>
      </div>
      <Button
        ref={restoreAction.ref}
        {...restoreAction.agentProps}
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={() => onRestore(revision.versionId)}
        disabled={disabled}
        aria-label={`Restore ${revision.name}`}
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );
}
