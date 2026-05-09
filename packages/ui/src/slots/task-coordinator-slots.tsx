/**
 * Slots for task-coordinator (coding-agent) UI surfaces rendered by app-core.
 *
 * app-core deliberately does not import from @elizaos/app-task-coordinator —
 * that would create a package -> app-plugin dependency (coding-agent
 * components live under plugins/app-task-coordinator) and a circular edge
 * (task-coordinator already imports app-core for its hooks/types). Instead,
 * app plugins that want coding-agent surfaces call
 * `registerTaskCoordinatorSlots` with their component implementations at
 * boot time, and app-core renders them via the `*Slot` components below.
 *
 * Registration happens via a side-effect import in the root app entry (see
 * the task-coordinator slot-registration module).
 */

import type { ComponentType, JSX } from "react";
import type { CodingAgentSession } from "../api/client-types-cloud.js";

export type TaskCoordinatorCodingAgentSettingsSectionProps = Record<
  string,
  never
>;

export interface TaskCoordinatorCodingAgentTasksPanelProps {
  fullPage?: boolean;
}

export type TaskCoordinatorCodingAgentControlChipProps = Record<string, never>;

export interface TaskCoordinatorPtyConsoleBaseProps {
  activeSessionId: string;
  sessions: CodingAgentSession[];
  onClose: () => void;
  variant: "drawer" | "side-panel" | "full";
}

export interface TaskCoordinatorSlots {
  CodingAgentSettingsSection: ComponentType<TaskCoordinatorCodingAgentSettingsSectionProps>;
  CodingAgentTasksPanel: ComponentType<TaskCoordinatorCodingAgentTasksPanelProps>;
  CodingAgentControlChip: ComponentType<TaskCoordinatorCodingAgentControlChipProps>;
  PtyConsoleBase: ComponentType<TaskCoordinatorPtyConsoleBaseProps>;
}

let registered: Partial<TaskCoordinatorSlots> = {};

export function registerTaskCoordinatorSlots(
  components: Partial<TaskCoordinatorSlots>,
): void {
  registered = { ...registered, ...components };
}

export function CodingAgentSettingsSection(
  props: TaskCoordinatorCodingAgentSettingsSectionProps,
): JSX.Element | null {
  const Component = registered.CodingAgentSettingsSection;
  return Component ? <Component {...props} /> : null;
}

export function CodingAgentTasksPanel(
  props: TaskCoordinatorCodingAgentTasksPanelProps,
): JSX.Element | null {
  const Component = registered.CodingAgentTasksPanel;
  return Component ? <Component {...props} /> : null;
}

export function CodingAgentControlChip(
  props: TaskCoordinatorCodingAgentControlChipProps,
): JSX.Element | null {
  const Component = registered.CodingAgentControlChip;
  return Component ? <Component {...props} /> : null;
}

export function PtyConsoleBase(
  props: TaskCoordinatorPtyConsoleBaseProps,
): JSX.Element | null {
  const Component = registered.PtyConsoleBase;
  return Component ? <Component {...props} /> : null;
}
