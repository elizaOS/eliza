/**
 * Statically registers the managed Cloud Notes page with the app shell.
 *
 * Native clients prohibit remotely supplied JavaScript, so the renderer is a
 * lazy chunk in the signed app bundle while the runtime plugin supplies only
 * metadata, capabilities, and durable state.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { NOTES_SURFACE } from "./surface.js";

registerAppShellPage({
  id: "notes",
  pluginId: "@elizaos/plugin-notes",
  label: "Notes",
  icon: "StickyNote",
  path: "/notes",
  order: 920,
  viewKind: "release",
  surface: NOTES_SURFACE,
  loader: () =>
    import("./views/NotesPage.tsx").then((module) => ({
      default: module.NotesPage,
    })),
});
