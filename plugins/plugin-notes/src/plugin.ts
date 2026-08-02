/**
 * Runtime declaration for the managed Cloud Notes view: one agent-drivable
 * view backed by a durable per-agent service, delegating navigation and
 * interaction transport to the shared VIEWS system.
 */

import type { Plugin } from "@elizaos/core";
import { NOTES_CAPABILITIES } from "./capabilities.js";
import { serverInteract } from "./interact.js";
import { notesRoutes } from "./routes.js";
import { NotesService } from "./service.js";

export const notesPlugin: Plugin = {
  name: "@elizaos/plugin-notes",
  description:
    "Managed Cloud Notes view with durable agent-driven CRUD and view switching.",
  services: [NotesService],
  routes: notesRoutes,
  views: [
    {
      id: "notes",
      label: "Notes",
      description:
        "Durable notes that the user and agent can create, read, update, and delete.",
      icon: "StickyNote",
      path: "/notes",
      order: 920,
      viewKind: "release",
      modalities: ["gui"],
      tags: [
        "notes",
        "notepad",
        "sticky notes",
        "scratchpad",
        "view switching",
      ],
      bundlePath: "dist/views/bundle.js",
      componentExport: "NotesView",
      surface: { header: "fullscreen" },
      capabilities: NOTES_CAPABILITIES,
      serverInteract,
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  async dispose(runtime) {
    await runtime.getService<NotesService>(NotesService.serviceType)?.stop();
  },
};

export default notesPlugin;
