/**
 * Canonical navigation vocabulary for Tier-0 shared-runtime agents: the map
 * from a view-command-matcher id to the CLIENT view id + human label a turn may
 * emit in a VIEWS handoff. The shared tier emits only these ids; the client
 * owns id→path resolution against its routable view registry, and an id absent
 * from that registry renders the designed not-found state (#17020, PR #17021).
 * Matcher ids and client ids are separate namespaces — the matcher's "wallet"
 * resolves to the builtin "inventory" tab — so this table is the single
 * translation point, and it deliberately omits matcher ids with no client
 * surface at all (e.g. "help") so those utterances fall through to the normal
 * LLM turn instead of navigating into not-found (#17032). The vocabulary is
 * pinned by the cross-package contract test
 * packages/ui/src/shared-nav-contract.test.ts.
 */

/** A client-resolvable navigation target for one matcher id. */
export interface SharedNavTarget {
  /** View id the client resolves against its routable view registry. */
  viewId: string;
  /** Human label used in confirmation copy ("Opening <label> for you."). */
  label: string;
}

export const SHARED_NAV_TARGETS: Readonly<Record<string, SharedNavTarget>> = {
  settings: { viewId: "settings", label: "Settings" },
  // The builtin wallet surface registers as the "inventory" tab (TAB_PATHS
  // inventory → /wallet in packages/ui/src/navigation); emitting the matcher's
  // raw "wallet" id would land in the client's not-found state.
  wallet: { viewId: "inventory", label: "Wallet" },
  calendar: { viewId: "calendar", label: "Calendar" },
  inbox: { viewId: "inbox", label: "Inbox" },
  finances: { viewId: "finances", label: "Finances" },
  focus: { viewId: "focus", label: "Focus" },
  goals: { viewId: "goals", label: "Goals" },
  health: { viewId: "health", label: "Health" },
  todos: { viewId: "todos", label: "To-dos" },
  notes: { viewId: "notes", label: "Notes" },
  documents: { viewId: "documents", label: "Documents" },
  memories: { viewId: "memories", label: "Memories" },
  relationships: { viewId: "relationships", label: "Relationships" },
  background: { viewId: "background", label: "Background" },
  transcripts: { viewId: "transcripts", label: "Transcripts" },
  character: { viewId: "character", label: "Character" },
  automations: { viewId: "automations", label: "Automations" },
  chat: { viewId: "chat", label: "Home" },
  camera: { viewId: "camera", label: "Camera" },
  "task-coordinator": { viewId: "task-coordinator", label: "Task Coordinator" },
};
