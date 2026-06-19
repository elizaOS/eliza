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
 * Toolbar: Generate from prompt, Format JSON, Save, Run. Validation is
 * always-on via the debounced parse above (the status badge shows
 * Valid/Invalid live), so there is no separate manual "Validate" control.
 */

import { Play, Save, Sparkles, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import {
  isMissingCredentialsResponse,
  type WorkflowDefinition,
  type WorkflowDefinitionGenerateResponse,
} from "../../api/client-types-chat";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useModalState } from "../../hooks/useModalState";
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [generatorPrompt, setGeneratorPrompt] = useState("");
  const generatorModal = useModalState();
  const generatorOpen = generatorModal.state.status !== "closed";
  const generating = generatorModal.state.status === "submitting";
  const generatorError =
    generatorModal.state.status === "error"
      ? generatorModal.state.error.message
      : null;

  // Re-parse on debounced text change.
  useEffect(() => {
    const result = parseWorkflowJson(debouncedText);
    setParseState(result);
    if (result.ok) setLastValidWorkflow(result.workflow);
  }, [debouncedText]);

  const isValid = parseState.ok;

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
      const saved = initial?.id
        ? await client.updateWorkflowDefinition(initial.id, req)
        : await client.createWorkflowDefinition(req);
      onSaved?.(saved);
      setLastValidWorkflow(saved);
      setText(workflowToJsonText(saved));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save workflow.");
    } finally {
      setSaving(false);
    }
  }, [parseState, initial?.id, onSaved]);

  const handleActivateRun = useCallback(async () => {
    if (!initial?.id) {
      setSaveError("Save the workflow before running it.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await client.activateWorkflowDefinition(initial.id);
      setLastValidWorkflow(updated);
      setText(workflowToJsonText(updated));
    } catch (e) {
      setSaveError(
        e instanceof Error ? e.message : "Failed to activate workflow.",
      );
    } finally {
      setSaving(false);
    }
  }, [initial?.id]);

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
      setLastValidWorkflow(definition);
      setText(workflowToJsonText(definition));
      setGeneratorPrompt("");
      return definition;
    });
  }, [generatorPrompt, generatorModal, initial?.id]);

  const lineErrorBanner = useMemo(() => {
    if (parseState.ok) return null;
    const invalid = parseState as Extract<WorkflowJsonResult, { ok: false }>;
    const where = invalid.line ? ` (line ${invalid.line})` : "";
    return `${invalid.message}${where}`;
  }, [parseState]);

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
    id: "activate-run",
    role: "button",
    label: "Activate",
    group: "workflow-toolbar",
    description: "Activate and run the saved workflow.",
    onActivate: () => void handleActivateRun(),
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
        {initial?.id && (
          <Button
            ref={activateButton.ref}
            {...activateButton.agentProps}
            variant="outline"
            size="sm"
            onClick={() => void handleActivateRun()}
            disabled={saving}
          >
            <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Activate
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

        <PagePanel
          variant="inset"
          className="flex min-h-0 flex-col overflow-hidden rounded-sm"
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
