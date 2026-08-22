/**
 * Renderer registration entry for @elizaos/plugin-personal-assistant. The app
 * shell imports this once after first paint (opted in via
 * `elizaos.appRegister: "register"` in package.json) in every renderer window
 * — so it must not start work at import time. Instead it registers the LifeOps
 * activity-signal capture as a lifecycle-scoped renderer service: the host
 * starts it only in main app windows (never popouts, detached shells, the
 * phone companion, app windows, or the model tester), retains the returned
 * (now async-capable) stop, and invokes it on page teardown, host
 * replacement, and HMR re-registration (#16504). The host's per-instance
 * context (shell/abort signal) is passed straight through so the capture
 * matches the renderer-service `start` contract and the registry can
 * serialize a successor's start behind this instance's async cleanup
 * (#17110).
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { registerRendererService } from "@elizaos/ui/platform/renderer-services";
import { startLifeOpsActivitySignalCapture } from "./lifeops/activity-signals-capture.js";

registerAppShellPage({
  id: "lifeops-connections",
  pluginId: "@elizaos/plugin-personal-assistant",
  label: "Mail & Calendars",
  icon: "Cable",
  path: "/lifeops/connections",
  order: 905,
  viewKind: "release",
  surface: { header: "fullscreen", capabilities: ["agent-surface"] },
  loader: () =>
    import("./components/lifeops-connections/LifeOpsConnectionsView.tsx").then(
      (module) => ({ default: module.LifeOpsConnectionsView }),
    ),
});

registerRendererService({
  id: "personal-assistant.lifeops-activity-signals",
  shells: ["main"],
  start: (context) => startLifeOpsActivitySignalCapture(true, context),
});
