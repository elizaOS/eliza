/**
 * Canonical navigation vocabulary for Tier-0 shared-runtime agents: the map
 * from a view-command-matcher id to the CLIENT view id + human label a turn may
 * emit in a VIEWS handoff. The shared tier emits only these ids; the client
 * resolves each id against its routable view registry (#17020, PR #17021), but
 * an id that registry cannot resolve still falls back to a blind /apps/<id>
 * navigation — the designed not-found render for unclaimed /apps/<slug> routes
 * is #17033 — so every entry here must be client-resolvable. Matcher ids and
 * client ids are separate namespaces — the matcher's "wallet" resolves to the
 * builtin "inventory" tab — so this table is the single translation point.
 * Host-owned destinations also carry their canonical path because they are not
 * guaranteed to exist in every platform's in-process view registry. Matcher
 * ids with no shared-tier client surface (e.g. "help", "camera") are omitted
 * so those utterances fall through to the normal LLM turn instead of navigating
 * nowhere (#17032). The vocabulary is pinned by the cross-package contract test
 * packages/ui/src/shared-nav-contract.test.ts.
 */

/** A client-resolvable navigation target for one matcher id. */
export interface SharedNavTarget {
  /** View id the client resolves against its routable view registry. */
  viewId: string;
  /** Canonical path when the destination is host-owned rather than registry-owned. */
  viewPath?: string;
  /** Human label used in confirmation copy ("Opening <label> for you."). */
  label: string;
}

export const SHARED_NAV_UI_LOCALES = [
  "en",
  "es",
  "pt",
  "ja",
  "ko",
  "vi",
  "zh-CN",
  "tl",
] as const;

export type SharedNavUiLocale = (typeof SHARED_NAV_UI_LOCALES)[number];

/** Labels and semantic aliases that resolve to one shared navigation target. */
export interface SharedNavVocabulary extends SharedNavTarget {
  localizedLabels: Readonly<Record<SharedNavUiLocale, string>>;
  aliases: readonly string[];
}

const DOCUMENTS_LOCALIZED_LABELS = {
  en: "Knowledge",
  es: "Conocimiento",
  pt: "Conhecimento",
  ja: "ナレッジ",
  ko: "지식",
  vi: "Tri thức",
  "zh-CN": "知识",
  tl: "Kaalaman",
} as const satisfies Readonly<Record<SharedNavUiLocale, string>>;

export const DOCUMENTS_NAV_VOCABULARY = {
  viewId: "documents",
  label: DOCUMENTS_LOCALIZED_LABELS.en,
  localizedLabels: DOCUMENTS_LOCALIZED_LABELS,
  aliases: ["knowledge base", "knowledge hub"],
} as const satisfies SharedNavVocabulary;

export const SHARED_NAV_TARGETS: Readonly<Record<string, SharedNavTarget>> = {
  settings: { viewId: "settings", label: "Settings" },
  vault: { viewId: "vault", label: "Vault" },
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
  documents: {
    viewId: DOCUMENTS_NAV_VOCABULARY.viewId,
    label: DOCUMENTS_NAV_VOCABULARY.label,
  },
  memories: { viewId: "memories", label: "Memories" },
  relationships: { viewId: "relationships", label: "Relationships" },
  background: { viewId: "background", label: "Background" },
  transcripts: { viewId: "transcripts", label: "Transcripts" },
  character: { viewId: "character", label: "Character" },
  automations: { viewId: "automations", label: "Automations" },
  "cloud-apps": {
    viewId: "cloud-apps",
    viewPath: "/cloud-apps",
    label: "Cloud Apps",
  },
  chat: { viewId: "chat", label: "Home" },
  // "camera" is deliberately absent: the camera view is an AOSP-fork-only
  // native surface, and AOSP devices run dedicated local runtimes whose real
  // VIEWS action handles camera — never the Tier-0 shared path. On the clients
  // a shared-tier agent actually serves (web/desktop/iOS), /camera renders the
  // ViewUnavailableFallback launcher grid.
  "task-coordinator": { viewId: "task-coordinator", label: "Task Coordinator" },
};
