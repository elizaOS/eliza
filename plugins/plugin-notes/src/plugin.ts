/**
 * Runtime declaration for the managed Cloud Notes view: one agent-drivable
 * view backed by a durable per-agent service, delegating navigation and
 * interaction transport to the shared VIEWS system.
 */

import type { ContextDefinition, Plugin } from "@elizaos/core";
import { notesAction } from "./action.js";
import { NOTES_CAPABILITIES } from "./capabilities.js";
import { serverInteract } from "./interact.js";
import { notesProvider } from "./provider.js";
import { notesRoutes } from "./routes.js";
import { NotesService } from "./service.js";

/**
 * Stage 1 classifies a turn into registered CONTEXTS, not actions: a context
 * the taxonomy lacks is a request Stage 1 cannot name, however well the action
 * itself advertises. Without this entry, "what notes do i have?" classified
 * into documents/contacts/memory and the NOTES action was never a candidate —
 * the read then honestly reported an absence from the wrong store.
 */
const NOTES_CONTEXT: ContextDefinition = {
  id: "notes",
  label: "Notes",
  description:
    "The user's saved notes — short facts and reminders-to-self they asked to write down ('note that…', 'jot this down') and read back ('what notes do i have', 'do i have a note about…', 'what did my note say'). Covers reading, searching, updating, and deleting those notes. A note is not a long-form document, not a todo, and not a calendar event; a notes read must never classify as documents, contacts, or memory.",
  descriptionCompressed:
    "User's saved notes: write down, read back, search, update, delete",
  sensitivity: "personal",
  cacheScope: "agent",
  roleGate: { minRole: "OWNER" },
};

export const notesPlugin: Plugin = {
  name: "@elizaos/plugin-notes",
  description:
    "Managed Cloud Notes view with durable agent-driven CRUD and view switching.",
  contexts: ["notes"],
  async init(_config, runtime) {
    runtime.contexts.tryRegister(NOTES_CONTEXT);
  },
  actions: [notesAction],
  providers: [notesProvider],
  services: [NotesService],
  routes: notesRoutes,
  views: [
    {
      id: "notes",
      label: "Notes",
      roleGate: { minRole: "OWNER" },
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
      relatedActions: ["NOTES"],
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
