import { loadContextInspectorView, registerAppShellPage } from "@elizaos/ui";

/** Registers the redacted context inspector as a developer-only app page. */

registerAppShellPage({
  id: "context-inspector",
  pluginId: "@elizaos/app",
  label: "Context Inspector",
  icon: "ScanSearch",
  path: "/apps/context-inspector",
  viewKind: "developer",
  order: 84,
  loader: () =>
    loadContextInspectorView().then((module) => ({
      default: module.default,
    })),
});
