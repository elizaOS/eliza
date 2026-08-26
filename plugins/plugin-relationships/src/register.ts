/**
 * Registers the Relationships view as a signed app-shell page. The runtime
 * plugin owns graph data and actions; this side-effect entry owns only the
 * renderer surface needed by native clients that cannot load remote bundles.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "relationships",
  pluginId: "@elizaos/plugin-relationships",
  label: "Relationships",
  icon: "Users",
  path: "/relationships",
  pathPatterns: ["/apps/relationships", "/character/relationships"],
  tabAffinity: "relationships",
  order: 930,
  viewKind: "developer",
  developerOnly: true,
  surface: {
    header: "fullscreen",
    capabilities: ["agent-surface"],
  },
  loader: () =>
    import("./components/relationships/RelationshipsPage.tsx").then(
      (module) => ({
        default: module.RelationshipsPage,
      }),
    ),
});
