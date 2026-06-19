/**
 * WorkflowEditor — text-first workflow editing surface.
 *
 * Layout: split-pane on desktop (JSON editor left, React Flow viewer
 * right). On narrow viewports the editor stacks above the viewer.
 *
 * The JSON editor is a plain `<textarea>` — Monaco / CodeMirror are too
 * heavy for the few hundred lines of JSON a workflow contains, and
 * neither library is currently a dependency of `@elizaos/ui`.
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
  Clock3,
  Pause,
  PlayCircle,
  Power,
  RefreshCw,
  Save,
  Sparkles,
  Wand2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import {
  isMissingCredentialsResponse,
  type WorkflowDefinition,
  type WorkflowDefinitionGenerateResponse,
  type WorkflowExecution,
} from "../../api/client-types-chat";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useModalState } from "../../hooks/useModalState";
import {
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { StatusBadge } from "../ui/status-badge";
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
  const [generatorPrompt, setGeneratorPrompt] = useState("");
  const generatorModal = useModalState();
  const generatorOpen = generatorModal.state.status !== "closed";
  const generating = generatorModal.state.status === "submitting";
  const generatorError =
    generatorModal.state.status === "error"
      ? generatorModal.state.error.message
      : null;

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
  }, [initial?.id]);

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
      setLastValidWorkflow(saved);
      setText(workflowToJsonText(saved));
      onSaved?.(saved);
      void refreshExecutions();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save workflow.");
    } finally {
      setSaving(false);
    }
  }, [parseState, persistedWorkflowId, onSaved, refreshExecutions]);

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
      setLastValidWorkflow(updated);
      setText(workflowToJsonText(updated));
    } catch (e) {
      setSaveError(
        e instanceof Error ? e.message : "Failed to update workflow state.",
      );
    } finally {
      setSaving(false);
    }
  }, [persistedWorkflowId, workflowIsActive]);

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
    } catch (e) {
      setExecutionError(
        e instanceof Error ? e.message : "Failed to run workflow.",
      );
    } finally {
      setRunning(false);
    }
  }, [persistedWorkflowId]);

  const handleGenerate = useCallback(async () => {
    const prompt = generatorPrompt.trim();
    if (!prompt) return;
    await generatorModal.submit(async () => {
      let res: WorkflowDefinitionGenerateResponse;
      try {
        res = await client.generateWorkflowDefinition({
          prompt,
          workflowId: initial?.id,
        });
      } catch (e) {
        throw e instanceof Error
          ? e
          : new Error("Failed to generate workflow.");
      }
      if ("status" in res && res.status === "needs_clarification") {
        throw new Error(
          "The workflow generator needs clarification — open the Automations chat to answer.",
        );
      }
      if (isMissingCredentialsResponse(res)) {
        throw new Error(
          `Generated, but missing credentials: ${res.missingCredentials
            .map((c) => c.credType)
            .join(", ")}`,
        );
      }
      const definition = res as WorkflowDefinition;
      setPersistedWorkflowId(definition.id);
      setLastValidWorkflow(definition);
      setText(workflowToJsonText(definition));
      setGeneratorPrompt("");
      void refreshExecutions();
      return definition;
    });
  }, [generatorPrompt, generatorModal, initial?.id, refreshExecutions]);

  const lineErrorBanner = useMemo(() => {
    if (parseState.ok) return null;
    const invalid = parseState as Extract<WorkflowJsonResult, { ok: false }>;
    const where = invalid.line ? ` (line ${invalid.line})` : "";
    return `${invalid.message}${where}`;
  }, [parseState]);

  const selectedExecutionSummary = selectedExecution
    ? summarizeWorkflowExecution(selectedExecution)
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

  const generateButton = useAgentElement<HTMLButtonElement>({
    id: "generate-from-prompt",
    role: "button",
    label: "Generate from prompt",
    group: "workflow-toolbar",
    description: "Open the prompt-driven workflow generator.",
    onActivate: generatorModal.open,
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

  const closeButton = useAgentElement<HTMLButtonElement>({
    id: "close",
    role: "button",
    label: "Close",
    group: "workflow-toolbar",
    description: "Close the workflow editor.",
    onActivate: () => onCancel?.(),
  });

  const generatorPromptField = useAgentElement<HTMLTextAreaElement>({
    id: "generator-prompt",
    role: "textarea",
    label: "Workflow prompt",
    group: "workflow-generator",
    description: "Describe the workflow to generate.",
    getValue: () => generatorPrompt,
    onFill: (value) => setGeneratorPrompt(value),
  });

  const generatorSubmitButton = useAgentElement<HTMLButtonElement>({
    id: "generator-generate",
    role: "button",
    label: "Generate",
    group: "workflow-generator",
    description: "Generate the workflow from the prompt.",
    status: generating ? "busy" : undefined,
    onActivate: () => void handleGenerate(),
  });

  const generatorCancelButton = useAgentElement<HTMLButtonElement>({
    id: "generator-cancel",
    role: "button",
    label: "Cancel generation",
    group: "workflow-generator",
    description: "Close the workflow generator without generating.",
    onActivate: generatorModal.close,
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/40 pb-3">
        <div className="mr-auto flex items-center gap-2 min-w-0">
          <h2 className="truncate text-base font-semibold tracking-[-0.01em] text-txt">
            {lastValidWorkflow?.name ?? "New workflow"}
          </h2>
          <StatusBadge
            tone={isValid ? "success" : "danger"}
            label={isValid ? "Valid" : "Invalid JSON"}
          />
        </div>
        <Button
          ref={generateButton.ref}
          {...generateButton.agentProps}
          variant="outline"
          size="sm"
          onClick={generatorModal.open}
          disabled={generating}
        >
          <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Generate from prompt
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
          className="flex min-h-0 flex-col overflow-hidden rounded-sm p-0"
        >
          <div className="flex items-center justify-between border-b border-border/40 px-3 py-2 text-xs text-muted-strong">
            <span className="font-medium text-txt">workflow.json</span>
            <span>{text.split("\n").length} lines</span>
          </div>
          <textarea
            ref={jsonEditor.ref}
            {...jsonEditor.agentProps}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            data-testid="workflow-editor-json"
            className="min-h-[320px] flex-1 resize-none border-0 bg-transparent p-3 font-mono text-xs leading-relaxed text-txt outline-none"
          />
        </PagePanel>

        <div className="flex min-h-0 flex-col gap-3">
          <PagePanel
            variant="inset"
            className="flex min-h-[280px] flex-1 flex-col overflow-hidden rounded-sm"
          >
            <div className="border-b border-border/40 px-3 py-2 text-xs font-medium text-txt">
              Graph
            </div>
            <div className="flex-1 p-3">
              <WorkflowGraphViewer
                workflow={lastValidWorkflow}
                loading={false}
                isGenerating={generating}
                emptyStateActionLabel="Generate from prompt"
                emptyStateHelpText="Describe the trigger and the steps. The graph re-renders on every JSON change."
                onEmptyStateAction={generatorModal.open}
              />
            </div>
          </PagePanel>

          <PagePanel
            variant="inset"
            className="flex min-h-[260px] flex-col overflow-hidden rounded-sm"
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-2">
              <div className="mr-auto min-w-0">
                <div className="text-xs font-medium text-txt">Runs</div>
                <div className="truncate text-2xs text-muted-strong">
                  {persistedWorkflowId
                    ? `${executions.length} recent execution${executions.length === 1 ? "" : "s"}`
                    : "Save before running"}
                </div>
              </div>
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
              <div className="border-b border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
                {executionError}
              </div>
            )}
            <div className="grid min-h-0 flex-1 gap-0 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
              <div className="min-h-[96px] overflow-auto border-b border-border/40 md:border-r md:border-b-0">
                {executions.length === 0 ? (
                  <div className="flex h-full min-h-[96px] items-center px-3 text-xs text-muted-strong">
                    {persistedWorkflowId
                      ? "No runs yet."
                      : "Save the workflow to run it."}
                  </div>
                ) : (
                  <div className="divide-y divide-border/40">
                    {executions.map((execution) => {
                      const summary = summarizeWorkflowExecution(execution);
                      const selected = execution.id === selectedExecution?.id;
                      return (
                        <button
                          key={execution.id}
                          type="button"
                          className={`flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-bg-accent/50 ${
                            selected ? "bg-bg-accent" : ""
                          }`}
                          onClick={() => setSelectedExecutionId(execution.id)}
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
                              {new Date(execution.startedAt).toLocaleString()} /{" "}
                              {summary.durationLabel}
                            </span>
                          </span>
                        </button>
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
                      <StatusBadge
                        tone={selectedExecutionSummary.tone}
                        label={selectedExecutionSummary.statusLabel}
                      />
                      <span className="text-2xs text-muted-strong">
                        {selectedExecutionSummary.nodeCount} node
                        {selectedExecutionSummary.nodeCount === 1 ? "" : "s"} /{" "}
                        {selectedExecutionSummary.durationLabel}
                      </span>
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
                        {selectedRunRows.map((row, index) => (
                          <div
                            key={`${row.nodeName}-${index}`}
                            className="rounded-sm border border-border/50 bg-bg/40 p-2"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <StatusBadge
                                tone={
                                  row.status === "error"
                                    ? "danger"
                                    : row.status === "success"
                                      ? "success"
                                      : "muted"
                                }
                                label={row.status}
                              />
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
        </div>
      </div>

      {/* Generator modal */}
      <Dialog
        open={generatorOpen}
        onOpenChange={(open) => {
          if (!open && !generating) generatorModal.close();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Generate workflow from prompt</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              ref={generatorPromptField.ref}
              {...generatorPromptField.agentProps}
              value={generatorPrompt}
              onChange={(e) => setGeneratorPrompt(e.target.value)}
              placeholder="When a new starred email arrives in Gmail, post a summary in #ops on Slack."
              rows={5}
              autoFocus
            />
            {generatorError && (
              <div className="rounded-sm border border-danger/20 bg-danger/10 p-2 text-xs text-danger">
                {generatorError}
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button
                ref={generatorCancelButton.ref}
                {...generatorCancelButton.agentProps}
                variant="ghost"
                size="sm"
                onClick={generatorModal.close}
                disabled={generating}
              >
                Cancel
              </Button>
              <Button
                ref={generatorSubmitButton.ref}
                {...generatorSubmitButton.agentProps}
                variant="default"
                size="sm"
                onClick={() => void handleGenerate()}
                disabled={generating || !generatorPrompt.trim()}
              >
                {generating ? (
                  <Spinner className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                )}
                Generate
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
