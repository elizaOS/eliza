/**
 * Runtime declaration for the managed Cloud Notes view: one agent-drivable
 * view backed by a durable per-agent service, delegating navigation and
 * interaction transport to the shared VIEWS system.
 */
import { NOTES_CAPABILITIES } from "./capabilities.js";
import { NOTES_SURFACE } from "./surface.js";
import { NotesService } from "./service.js";
import { namedNotesProvider } from "./provider.js";
import { notesAction } from "./action.js";
import { notesProvider } from "./provider.js";
import { notesRoutes } from "./routes.js";
import { promoteSubactionsToActions } from "@elizaos/core";
import { serverInteract } from "./interact.js";
import { type ContextDefinition } from "@elizaos/core";
import { type HttpPlugin as Plugin } from "@elizaos/shared";
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
    description: "The user's saved Notes records, including temporary or titled notes. All Notes record operations use context notes and a promoted action candidate: create -> NOTES_CREATE; read an exact ID -> NOTES_GET; search, list, or count -> NOTES_LIST; date or period search -> NOTES_LIST with dateRange; edit fields or substitute literal text -> NOTES_PATCH; legacy whole-note replacement -> NOTES_UPDATE; remove -> NOTES_DELETE. Name the matching child instead of the NOTES umbrella so its required fields reach the planner. Explicit Notes records belong here; generic requests to remember durable facts or preferences use memory, and document/file work uses documents. A note is not a todo or calendar event. Add a navigation candidate only when opening the view is also requested: prefer VIEWS_SHOW when available; use VIEWS for layouts or discovery.",
    descriptionCompressed: "User's saved notes: write down, read back, search, update, delete",
    sensitivity: "personal",
    cacheScope: "agent",
    roleGate: { minRole: "OWNER" },
};
export const notesPlugin: Plugin = {
    name: "@elizaos/plugin-notes",
    description: "Managed Cloud Notes view with durable agent-driven CRUD and view switching.",
    contexts: ["notes"],
    async init(_config, runtime) {
        runtime.contexts.tryRegister(NOTES_CONTEXT);
    },
    actions: [
        ...promoteSubactionsToActions(notesAction, {
            overrides: {
                list: {
                    description: "Read current saved notes, including their IDs, exact titles/bodies and timestamps. Use content for a title/topic filter, noteId for an exact ID, and dateRange whenever the user requests creation/update date bounds. Pass that window in this read rather than listing all notes and filtering in the reply. Filters combine; omit all for the full list. The result contains every matching note and the applied date window. Saved-note provider text has no timestamps; restoring it cannot answer a date question. This operation does not change notes or open their view.",
                    parameters: notesAction.parameters?.map((parameter) => parameter.name === "content"
                        ? {
                            ...parameter,
                            description: "Optional title/topic text filter. Omit for all notes or date/recency comparisons; dates are not text-search terms. Use noteId instead for an exact ID.",
                        }
                        : parameter),
                },
                create: {
                    description: "Create the note the user asked to save. Separate note content from instructions about the app or the operation. Quotation marks that delimit a supplied title/body are not part of that value unless the user asks to include them; preserve quotes within the content and explicitly requested outer quotes. Preserve the selected content's punctuation, whitespace and line breaks exactly. If an unquoted trailing phrase could be either note content or an app instruction, ask which before writing instead of guessing. Put a separately supplied title and body in content joined by one newline. Creating a note does not open Notes; navigate separately only when requested.",
                },
                get: { similes: ["NOTES_GET_NOTE"] },
                patch: {
                    description: "Update one note. Required target identifies it by id or text. Use the user's identifying text when they name a note; if multiple records match, ask which one. An ID in the index is not evidence the user selected that record. Repairing edit arguments must not replace an ambiguous title with a guessed ID. For field replacement supply changes entries (field, value) and expectedRevision from the complete note snapshot used to prepare this edit. Never guess the revision. Any intervening Notes mutation, including deleting another note, requires a fresh complete read and reconciliation. Omitted fields remain unchanged; replacing a body does not require rewriting its title. Preserve exact user wording. For a literal word/substring substitution use NOTES_UPDATE with textEdit instead; its unique-match atomic operation needs no preliminary read or revision.",
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
            description: "Durable notes that the user and agent can create, read, update, and delete.",
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
