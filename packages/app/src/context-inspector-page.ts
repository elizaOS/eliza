/** Registers the redacted context inspector as a developer-only app page. */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "context-inspector",
  pluginId: "@elizaos/app",
  label: "Context Inspector",
  icon: "ScanSearch",
  path: "/apps/context-inspector",
  viewKind: "developer",
  order: 84,
  loader: () =>
    import("@elizaos/ui/components/ContextInspectorView").then((module) => ({
      default: module.default,
    })),
});
