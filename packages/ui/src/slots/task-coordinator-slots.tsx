import type { ComponentType } from "react";
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

const registeredTaskCoordinatorSlots: Partial<TaskCoordinatorSlots> = {};

export function registerTaskCoordinatorSlots(
  components: Partial<TaskCoordinatorSlots>,
): void {
  Object.assign(registeredTaskCoordinatorSlots, components);
}

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
