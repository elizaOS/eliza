/**
 * Registers the plugin-owned Knowledge document hub with the app shell.
 * Registration is metadata-only at startup; the complete multimedia surface
 * is loaded only when `/documents` or `/character/documents` is opened.
 */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "documents",
  pluginId: "@elizaos/plugin-documents",
  label: "Knowledge",
  icon: "Files",
  path: "/documents",
  pathPatterns: ["/character/documents"],
  tabAffinity: "documents",
  order: 120,
  viewKind: "system",
  surface: {
    header: "fullscreen",
    capabilities: ["agent-surface"],
  },
  loader: () =>
    import("./components/documents/KnowledgeView.tsx").then((module) => ({
      default: module.KnowledgeView,
    })),
});
