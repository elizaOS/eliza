export * from "./AgentTabsSection";
export * from "./api/coordinator-types";
export * from "./CodingAgentControlChip";
export * from "./CodingAgentSettingsSection";
export * from "./CodingAgentTasksPanel";
export * from "./coding-agent-settings-shared";
export * from "./GlobalPrefsSection";
export * from "./LlmProviderSection";
export * from "./ModelConfigSection";
export * from "./PtyConsoleBase";
export * from "./PtyConsoleDrawer";
export { PtyConsoleSidePanel } from "./PtyConsoleSidePanel";
export * from "./PtyTerminalPane";
export * from "./pty-status-dots";
export * from "./session-hydration";
export * from "./register-slots";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { PtyConsoleSidePanel as _bs_1_PtyConsoleSidePanel } from "./PtyConsoleSidePanel";
// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_PLUGINS_APP_TASK_COORDINATOR_SRC_INDEX__ = [_bs_1_PtyConsoleSidePanel];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(globalThis as any).__bundle_safety_PLUGINS_APP_TASK_COORDINATOR_SRC_INDEX__ = __bundle_safety_PLUGINS_APP_TASK_COORDINATOR_SRC_INDEX__;
