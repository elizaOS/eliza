/**
 * Runtime declaration for the managed Cloud Notes view: one agent-drivable
 * view backed by a durable per-agent service, delegating navigation and
 * interaction transport to the shared VIEWS system.
 */

import {
  type ContextDefinition,
  promoteSubactionsToActions,
  registerDirectActionRoutingRule,
} from "@elizaos/core";
import type { HttpPlugin as Plugin } from "@elizaos/host/protocol";
import { notesAction } from "./action.js";
import { NOTES_CAPABILITIES } from "./capabilities.js";
import { serverInteract } from "./interact.js";
import { namedNotesProvider, notesProvider } from "./provider.js";
import { notesRoutes } from "./routes.js";
import { NotesService } from "./service.js";
import { NOTES_SURFACE } from "./surface.js";

/**
 * Stage 1 classifies a turn into registered CONTEXTS, not actions: a context
 * the taxonomy lacks is a request Stage 1 cannot name, however well the action
 * itself advertises. Without this entry, "what notes do i have?" classified
 * into documents/contacts/memory and the NOTES action was never a candidate —
 * the read then honestly reported an absence from the wrong store.
 *
 * Stage 1 renders only descriptionCompressed, so it names the dictation verbs
 * and the note/reminder boundary.
 */
const NOTES_CONTEXT: ContextDefinition = {
  id: "notes",
  aliases: ["note"],
  label: "Notes",
  description: "Saved notes.",
  descriptionCompressed:
    "Jot/write down, read back notes; dates in notes are content, not reminders.",
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
    registerDirectActionRoutingRule(runtime, {
      id: "notes.create",
      actionNames: ["NOTES_CREATE"],
      requiredActionTags: ["resource:notes", "capability:write"],
      contexts: ["notes"],
      // A backend save does not depend on an open Notes view. Only direct
      // creation commands seed this operation; drafting, reported speech,
      // explanations and other CRUD requests retain ordinary routing.
      matches: (text) =>
        /^\s*(?:please\s+)?(?:create|save|add)\s+(?:(?:a|an|my|new)\s+)*notes?(?:\s|$|[,:])/iu.test(
          text,
        ),
    });
    registerDirectActionRoutingRule(runtime, {
      id: "notes.read",
      actionNames: ["NOTES_LIST"],
      requiredActionTags: ["resource:notes", "capability:read"],
      contexts: ["notes"],
      // Explicit store reads need current records; ordinary recall can still
      // answer from supplied evidence. The list operation supports a title filter.
      matches: (text) =>
        /^\s*(?:please\s+)?(?:read|list|search|find|look\s+up)\s+(?:(?:a|the|my|all|saved|latest)\s+)*notes?(?:\s|$|[,:])/iu.test(
          text,
        ),
    });
  },
  actions: [
    ...promoteSubactionsToActions(notesAction, {
      overrides: {
        list: {
          description:
            "Read current saved notes, including their IDs, exact titles/bodies and timestamps. Use content for a title/topic filter, noteId for an exact ID, and dateRange whenever the user requests creation/update date bounds. Pass that window in this read rather than listing all notes and filtering in the reply. Filters combine; omit all for the full list. The result contains every matching note and the applied date window unless latestBy explicitly selects the newest createdAt or updatedAt instant; all ties remain. Resolve that basis from user wording/context and state it; bare latest has no automatic default. Saved-note provider text has no timestamps; restoring it cannot answer a date question. This operation does not change notes or open their view.",
          parameters: notesAction.parameters?.map((parameter) =>
            parameter.name === "content"
              ? {
                  ...parameter,
                  description:
                    "Optional title/topic text filter. Omit for all notes or recency selection without a title/topic; use latestBy for its explicit timestamp basis and dateRange for date bounds. Dates are not text-search terms. Use noteId instead for an exact ID.",
                }
              : parameter,
          ),
        },
        create: {
          description:
            "Create the note the user asked to save. Separate note content from instructions about the app or the operation. Quotation marks that delimit a supplied title/body are not part of that value unless the user asks to include them; preserve quotes within the content and explicitly requested outer quotes. Preserve the selected content's punctuation, whitespace and line breaks exactly. If an unquoted trailing phrase could be either note content or an app instruction, ask which before writing instead of guessing. Put a separately supplied title and body in content joined by one newline. Creating a note does not open Notes; navigate separately only when requested.",
        },
        get: { similes: ["NOTES_GET_NOTE"] },
        patch: {
          description:
            "Update one note. Required target identifies it by id or text. Use the user's identifying text when they name a note; if multiple records match, ask which one. An ID in the index is not evidence the user selected that record. Repairing edit arguments must not replace an ambiguous title with a guessed ID. For field replacement supply changes entries (field, value) and notesRevision from the complete commit/read snapshot as expectedRevision. CREATE includes its exact transaction revision. Never guess the revision. Any intervening Notes mutation, including deleting another note, requires a fresh complete read and reconciliation. Body value excludes bodySeparator but preserves every authored leading newline and space. The store adds one framing newline; do not include the separator in the replacement. Omitted fields remain unchanged; replacing a body does not require rewriting its title. For a literal word/substring substitution use NOTES_UPDATE with textEdit instead; its unique-match atomic operation needs no preliminary read or revision.",
        },
      },
    }),
  ],
  providers: [notesProvider, namedNotesProvider],
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
      responseContext: { primaryContext: "notes" },
      bundlePath: "dist/views/bundle.js",
      componentExport: "NotesView",
      surface: NOTES_SURFACE,
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
