export * from "./AgentTabsSection";
export * from "./CodingAgentControlChip";
export * from "./CodingAgentSettingsSection";
export * from "./CodingAgentTasksPanel";
export * from "./coding-agent-settings-shared";
export * from "./GlobalPrefsSection";
export * from "./LlmProviderSection";
export * from "./ModelConfigSection";
export * from "./PtyConsoleBase";
export * from "./PtyConsoleSidePanel";
export * from "./register-slots";
export * from "./session-hydration";

// PtyConsoleSidePanel: legacy export still imported by plugin-app-companion's
// CompanionAppView / CompanionView. The original component was removed from
// this package's `src/` (only the prebuilt `dist/PtyConsoleBase` remains).
// Re-add a null-rendering placeholder so the renderer bundle doesn't fail
// with Rolldown MISSING_EXPORT — the side panel was a debug overlay and is
// non-essential. Once the component is restored, replace this stub.
import type { ReactNode } from "react";
export interface PtyConsoleSidePanelProps {
  activeSessionId?: string;
  sessions?: ReadonlyArray<unknown>;
  onClose?: () => void;
}
export function PtyConsoleSidePanel(
  _props: PtyConsoleSidePanelProps,
): ReactNode {
  return null;
}
