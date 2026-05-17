import type { TriggerSummary } from "../../api/client";
import { type TranslateFn, type TriggerFormState } from "./heartbeat-utils";
export interface HeartbeatFormProps {
  /** Current form state. */
  form: TriggerFormState;
  /** ID of the trigger being edited, or null when creating. */
  editingId: string | null;
  /** Whether the trigger (or form default) is enabled. */
  editorEnabled: boolean;
  /** Computed modal/editor title. */
  modalTitle: string;
  /** Form validation error message, if any. */
  formError: string | null;
  /** True while a save/create request is in flight. */
  triggersSaving: boolean;
  /** Template notice banner text. */
  templateNotice: string | null;
  /** All triggers (used for looking up the editing trigger's metadata). */
  triggers: TriggerSummary[];
  /** Run history keyed by trigger ID. */
  triggerRunsById: Record<string, import("../../api").TriggerRunRecord[]>;
  /** Translation function. */
  t: TranslateFn;
  /** Currently selected trigger ID. */
  selectedTriggerId: string | null;
  /** Set a single form field value. */
  setField: <K extends keyof TriggerFormState>(
    key: K,
    value: TriggerFormState[K],
  ) => void;
  /** Replace the entire form state. */
  setForm: (
    form: TriggerFormState | ((prev: TriggerFormState) => TriggerFormState),
  ) => void;
  /** Set form error message. */
  setFormError: (error: string | null) => void;
  /** Close the editor panel. */
  closeEditor: () => void;
  /** Submit the form (create or update). */
  onSubmit: () => Promise<void>;
  /** Delete the trigger being edited. */
  onDelete: () => Promise<void>;
  /** Run a trigger immediately. */
  onRunSelectedTrigger: (triggerId: string) => Promise<void>;
  /** Toggle a trigger's enabled state. */
  onToggleTriggerEnabled: (
    triggerId: string,
    currentlyEnabled: boolean,
  ) => Promise<void>;
  /** Save the current form as a template. */
  saveFormAsTemplate: () => void;
  /** Load run history for a trigger. */
  loadTriggerRuns: (triggerId: string) => Promise<void>;
  /** Optional override for the create-mode kicker label. */
  kickerLabelCreate?: string;
  /** Optional override for the edit-mode kicker label. */
  kickerLabelEdit?: string;
  /** Optional override for the create submit label. */
  submitLabelCreate?: string;
  /** Optional override for the edit submit label. */
  submitLabelEdit?: string;
}
export declare function HeartbeatForm({
  form,
  editingId,
  editorEnabled,
  modalTitle,
  formError,
  triggersSaving,
  templateNotice,
  triggers,
  triggerRunsById,
  t,
  selectedTriggerId,
  setField,
  setForm,
  setFormError,
  closeEditor,
  onSubmit,
  onDelete,
  onRunSelectedTrigger,
  onToggleTriggerEnabled,
  saveFormAsTemplate,
  loadTriggerRuns,
  kickerLabelCreate,
  kickerLabelEdit,
  submitLabelCreate,
  submitLabelEdit,
}: HeartbeatFormProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=HeartbeatForm.d.ts.map
