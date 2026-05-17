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
 * Toolbar: Generate from prompt, Validate, Save, Run. The Validate
 * action is local-only (re-runs `parseWorkflowJson`) until the workflow
 * plugin exposes a richer validation endpoint.
 */
import { type WorkflowDefinition } from "../../api/client-types-chat";
export interface WorkflowEditorProps {
  initial?: WorkflowDefinition | null;
  onSaved?: (workflow: WorkflowDefinition) => void;
  onCancel?: () => void;
}
export declare function WorkflowEditor({
  initial,
  onSaved,
  onCancel,
}: WorkflowEditorProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=WorkflowEditor.d.ts.map
