/**
 * Registers the plugin-owned Knowledge document hub with the app shell.
 * Registration is metadata-only at startup; the complete multimedia surface
 * is loaded only when `/documents` or `/character/documents` is opened.
 */
import { registerAppShellPage } from "@elizaos/ui";

let registered = false;

export function registerKnowledgeApp(): void {
  if (registered) return;
  registerAppShellPage({
    id: "documents",
    pluginId: "@elizaos/plugin-knowledge",
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
  registered = true;
}
