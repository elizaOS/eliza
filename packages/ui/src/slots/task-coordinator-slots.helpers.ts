/**
 * Registry state + registration entry point for task-coordinator
 * (coding-agent) UI slots. The `*Slot` components in
 * `task-coordinator-slots.tsx` read `registeredTaskCoordinatorSlots` from here;
 * app plugins call `registerTaskCoordinatorSlots` at boot to supply their
 * implementations.
 *
 * See `task-coordinator-slots.tsx` for the architectural note on why app-core
 * does not import from @elizaos/plugin-task-coordinator directly.
 */

import type { ComponentType } from "react";
import type { CodingAgentSession } from "../api/client-types-cloud.js";

export type TaskCoordinatorCodingAgentSettingsSectionProps = Record<
  string,
  never
>;

export interface TaskCoordinatorCodingAgentTasksPanelProps {
  fullPage?: boolean;
  /** Controlled project scope. A string filters to that project; null shows
   * only tasks that have not been assigned to a project. Omit for the legacy
   * all-projects panel with its own switcher. */
  projectId?: string | null;
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

export const registeredTaskCoordinatorSlots: Partial<TaskCoordinatorSlots> = {};

export function registerTaskCoordinatorSlots(
  components: Partial<TaskCoordinatorSlots>,
): void {
  Object.assign(registeredTaskCoordinatorSlots, components);
}
