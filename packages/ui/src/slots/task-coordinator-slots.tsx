/**
 * Slots for task-coordinator (coding-agent) UI surfaces rendered by app-core.
 *
 * app-core deliberately does not import from @elizaos/plugin-task-coordinator —
 * that would create a package -> app-plugin dependency (coding-agent
 * components live under plugins/plugin-task-coordinator) and a circular edge
 * (task-coordinator already imports app-core for its hooks/types). Instead,
 * app plugins that want coding-agent surfaces call
 * `registerTaskCoordinatorSlots` with their component implementations at
 * boot time, and app-core renders them via the `*Slot` components below.
 *
 * Registration happens via a side-effect import in the root app entry (see
 * the task-coordinator slot-registration module).
 */

import {
  registeredTaskCoordinatorSlots,
  type TaskCoordinatorCodingAgentControlChipProps,
  type TaskCoordinatorCodingAgentSettingsSectionProps,
  type TaskCoordinatorCodingAgentTasksPanelProps,
  type TaskCoordinatorPtyConsoleBaseProps,
} from "./task-coordinator-slots.helpers";

export type {
  TaskCoordinatorCodingAgentControlChipProps,
  TaskCoordinatorCodingAgentSettingsSectionProps,
  TaskCoordinatorCodingAgentTasksPanelProps,
  TaskCoordinatorPtyConsoleBaseProps,
  TaskCoordinatorSlots,
} from "./task-coordinator-slots.helpers";

export function CodingAgentSettingsSection(
  props: TaskCoordinatorCodingAgentSettingsSectionProps,
): React.JSX.Element | null {
  const Component = registeredTaskCoordinatorSlots.CodingAgentSettingsSection;
  return Component ? <Component {...props} /> : null;
}

export function CodingAgentTasksPanel(
  props: TaskCoordinatorCodingAgentTasksPanelProps,
): React.JSX.Element | null {
  const Component = registeredTaskCoordinatorSlots.CodingAgentTasksPanel;
  return Component ? <Component {...props} /> : null;
}

export function CodingAgentControlChip(
  props: TaskCoordinatorCodingAgentControlChipProps,
): React.JSX.Element | null {
  const Component = registeredTaskCoordinatorSlots.CodingAgentControlChip;
  return Component ? <Component {...props} /> : null;
}

export function PtyConsoleBase(
  props: TaskCoordinatorPtyConsoleBaseProps,
): React.JSX.Element | null {
  const Component = registeredTaskCoordinatorSlots.PtyConsoleBase;
  return Component ? <Component {...props} /> : null;
}
