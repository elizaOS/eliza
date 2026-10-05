import { type ComponentType, useSyncExternalStore } from "react";
import type { CodingAgentSession } from "../api/client-types-cloud.js";
import { getUiRegistryStore } from "../registry-host.js";

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

function slotStore() {
  return getUiRegistryStore("task-coordinator-slots", () => ({
    components: {} as Partial<TaskCoordinatorSlots>,
    listeners: new Set<() => void>(),
  }));
}

function subscribeSlots(listener: () => void): () => void {
  const { listeners } = slotStore();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useSlot<K extends keyof TaskCoordinatorSlots>(name: K) {
  const snapshot = () => slotStore().components[name];
  return useSyncExternalStore(subscribeSlots, snapshot, snapshot);
}

export function registerTaskCoordinatorSlots(
  components: Partial<TaskCoordinatorSlots>,
): void {
  const store = slotStore();
  Object.assign(store.components, components);
  for (const listener of store.listeners) listener();
}

export function CodingAgentSettingsSection(
  props: TaskCoordinatorCodingAgentSettingsSectionProps,
): React.JSX.Element | null {
  const Component = useSlot("CodingAgentSettingsSection");
  return Component ? <Component {...props} /> : null;
}

export function CodingAgentTasksPanel(
  props: TaskCoordinatorCodingAgentTasksPanelProps,
): React.JSX.Element | null {
  const Component = useSlot("CodingAgentTasksPanel");
  return Component ? <Component {...props} /> : null;
}

export function CodingAgentControlChip(
  props: TaskCoordinatorCodingAgentControlChipProps,
): React.JSX.Element | null {
  const Component = useSlot("CodingAgentControlChip");
  return Component ? <Component {...props} /> : null;
}

export function PtyConsoleBase(
  props: TaskCoordinatorPtyConsoleBaseProps,
): React.JSX.Element | null {
  const Component = useSlot("PtyConsoleBase");
  return Component ? <Component {...props} /> : null;
}
