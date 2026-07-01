/**
 * Side-effect module that registers task-coordinator React components
 * with app-core's slot registry at import time.
 *
 * The root app loads this module from its main entry so app-core's slot
 * wrappers — CodingAgentSettingsSection,
 * CodingAgentTasksPanel, CodingAgentControlChip — render the real
 * components. Without this import they render as empty slot defaults.
 *
 * This keeps app-core → app-task-coordinator off the static import graph
 * (app-core depends only on its own slot registry) while still letting
 * task-coordinator depend on app-core for hooks, types, and the client.
 */

import { registerTaskCoordinatorSlots, registerTaskWidget } from "@elizaos/ui";
import type {
  TaskCoordinatorCodingAgentControlChipProps,
  TaskCoordinatorCodingAgentSettingsSectionProps,
  TaskCoordinatorCodingAgentTasksPanelProps,
  TaskCoordinatorPtyConsoleBaseProps,
} from "@elizaos/ui/slots/task-coordinator-slots";
import {
  type ComponentType,
  createElement,
  type LazyExoticComponent,
  lazy,
  Suspense,
} from "react";

function lazySlot<P extends object>(
  loader: () => Promise<{ default: ComponentType<P> }>,
): ComponentType<P> {
  const LazyComponent: LazyExoticComponent<ComponentType<P>> = lazy(loader);
  return function LazyTaskCoordinatorSlot(props: P) {
    return createElement(
      Suspense,
      { fallback: null },
      createElement(LazyComponent, props),
    );
  };
}

export const CodingAgentControlChip =
  lazySlot<TaskCoordinatorCodingAgentControlChipProps>(() =>
    import("./CodingAgentControlChip.js").then((module) => ({
      default: module.CodingAgentControlChip,
    })),
  );
export const CodingAgentSettingsSection =
  lazySlot<TaskCoordinatorCodingAgentSettingsSectionProps>(() =>
    import("./CodingAgentSettingsSection.js").then((module) => ({
      default: module.CodingAgentSettingsSection,
    })),
  );
export const CodingAgentTasksPanel =
  lazySlot<TaskCoordinatorCodingAgentTasksPanelProps>(() =>
    import("./CodingAgentTasksPanel.js").then((module) => ({
      default: module.CodingAgentTasksPanel,
    })),
  );
export const PtyConsoleBase = lazySlot<TaskCoordinatorPtyConsoleBaseProps>(() =>
  import("./PtyConsoleBase.js").then((module) => ({
    default: module.PtyConsoleBase,
  })),
);

registerTaskCoordinatorSlots({
  CodingAgentControlChip,
  CodingAgentSettingsSection,
  CodingAgentTasksPanel,
  PtyConsoleBase,
});

// The orchestrator owns the in-chat task widget: a reply's `[TASK:<id>]` marker
// renders the live task card only when this plugin is loaded.
registerTaskWidget();
