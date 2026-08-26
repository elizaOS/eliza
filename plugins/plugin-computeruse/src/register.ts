/**
 * Registers the signed Computer Sessions page with the app shell. The local
 * component is the packaged fallback when the opt-in runtime has not supplied
 * its richer remote view bundle, so readiness and failure states remain visible.
 */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "computer-use-sessions",
  pluginId: "@elizaos/plugin-computeruse",
  label: "Computer Sessions",
  icon: "MonitorUp",
  path: "/computer-use-sessions",
  order: 930,
  viewKind: "release",
  surface: { capabilities: ["agent-surface"] },
  loader: () =>
    import("./views/ComputerUseSessionsView.tsx").then((module) => ({
      default: module.ComputerUseSessionsView,
    })),
});
