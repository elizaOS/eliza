/**
 * TaskEditor — single-screen editor for a "simple" automation: title,
 * prompt, and a schedule (once / recurring cron / on-event).
 *
 * Most users land here and don't need a node graph. The editor calls
 * `client.createWorkbenchTask` / `client.updateWorkbenchTask`. The
 * schedule is stored as `tags` because the WorkbenchTask shape doesn't
 * have a dedicated schedule field — the existing AutomationsView already
 * uses tags as free-form metadata. When the workflow plugin grows a
 * dedicated `cron` field on WorkbenchTask we can drop the tag encoding.
 */
import type { WorkbenchTask } from "../../api/client-types-config";
import { type TaskScheduleKind } from "../../utils/task-schedule";

export type { TaskScheduleKind } from "../../utils/task-schedule";
export {
  decodeScheduleTags,
  encodeScheduleTags,
} from "../../utils/task-schedule";
export interface TaskEditorInitialValue {
  id?: string;
  name: string;
  prompt: string;
  scheduleKind: TaskScheduleKind;
  cronExpression: string;
  eventName: string;
}
export interface TaskEditorProps {
  initial?: Partial<TaskEditorInitialValue>;
  /**
   * Available trigger events the user can pick from. The host should
   * source this from the runtime's trigger catalog. We accept it as a
   * prop so this component stays free of upstream coupling.
   */
  availableEvents?: ReadonlyArray<{
    id: string;
    label: string;
  }>;
  onSaved?: (task: WorkbenchTask) => void;
  onCancel?: () => void;
}
export declare function TaskEditor({
  initial,
  availableEvents,
  onSaved,
  onCancel,
}: TaskEditorProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TaskEditor.d.ts.map
