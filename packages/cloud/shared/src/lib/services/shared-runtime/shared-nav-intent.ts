/**
 * Shared-runtime navigation intent — the Tier-0 fix for in-app navigation.
 *
 * A Tier-0 ("shared") agent runs container-free through `runSharedAgentTurn`,
 * which is a bare `generateText`/`streamText` with NO action pipeline and NO
 * plugins. The dedicated-runtime VIEWS action (plugin-app-control) — the thing
 * that turns "go to settings" into a real UI navigation — never loads there, so
 * before this module a shared agent answered every navigation command with a
 * hallucinated prose refusal ("I don't have a settings menu, I'm an AI…"). That
 * is the demo's "go to settings fails miserably" report (#F5-ACTIONS).
 *
 * The fix mirrors the dedicated runtime's deterministic fast path WITHOUT
 * booting any plugin: the SAME zero-model multilingual matcher the VIEWS action
 * uses (`@elizaos/shared/views/view-command-matcher`) resolves the utterance to
 * a builtin view id, and the turn emits a VIEWS navigation handoff — the exact
 * `actionResults` summary shape the PWA already consumes
 * (`findViewActionHandoff` → `dispatchNavigateViewEvent` in
 * packages/ui/src/view-action-handoff.ts) — plus a short confirmation reply.
 * No LLM call, no plugin, no container: sub-millisecond and demo-safe.
 *
 * Scope: ONLY unambiguous navigation commands short-circuit here (the matcher is
 * precision-first — a bare noun needs an explicit nav signal). Everything else
 * returns null and falls through to the normal LLM turn, byte-identical to
 * today. This is intentionally the navigation slice of the "first 5 minutes"
 * strike; content actions (create a note, etc.) still need a real runtime.
 */

import { matchViewCommand } from "@elizaos/shared/views/view-command-matcher";

/** A resolved navigation directive for a shared-runtime turn. */
export interface SharedNavIntent {
  /** Builtin view id the client resolves to a path (settings, wallet, chat, …). */
  viewId: string;
  /** Optional settings sub-section token to deep-link (e.g. "voice"). */
  subview?: string;
  /** Human label used in the confirmation reply. */
  label: string;
  /** The confirmation text streamed back as the assistant reply. */
  reply: string;
}

/**
 * Builtin views a shared agent can navigate to, with their human label. Kept as
 * a small local table (NOT an @elizaos/ui import) so the cloud worker bundle
 * stays lean — the client owns the viewId→path resolution, so the server only
 * needs the id + a friendly label for the confirmation copy. Every id here is a
 * `MATCHER_VIEW_IDS` value that also resolves to a real builtin surface on the
 * PWA (see packages/ui navigation TAB_PATHS + view-action-handoff builtin path
 * fallback `/apps/<viewId>`).
 */
const NAVIGABLE_VIEW_LABELS: Readonly<Record<string, string>> = {
  settings: "Settings",
  wallet: "Wallet",
  calendar: "Calendar",
  inbox: "Inbox",
  finances: "Finances",
  focus: "Focus",
  goals: "Goals",
  health: "Health",
  todos: "To-dos",
  notes: "Notes",
  documents: "Documents",
  memories: "Memories",
  relationships: "Relationships",
  background: "Background",
  transcripts: "Transcripts",
  character: "Character",
  automations: "Automations",
  help: "Help",
  chat: "Home",
  camera: "Camera",
  "task-coordinator": "Task Coordinator",
};

/**
 * "change my voice" / "change the voice" is a navigation to the Settings view's
 * Voice section, not a self-referential model-voice change the LLM would refuse.
 * A dedicated agent routes this through VIEWS action=show view=settings
 * subview=voice; we mirror that with a settings nav carrying subview=voice.
 * Precision-first, same spirit as the matcher: require an explicit voice-change
 * verb around a voice/speech noun so ordinary talk about "your voice" doesn't
 * hijack the turn.
 */
const VOICE_SETTINGS_INTENT =
  /\b(change|set|update|switch|configure|pick|choose|select|edit|customi[sz]e)\b[\s\S]{0,24}?\b(voice|tts|speech|accent)\b|\b(voice|tts|speech)\b[\s\S]{0,16}?\b(settings?|options?|preferences?)\b/i;

function navReply(label: string): string {
  return `Opening ${label} for you.`;
}

/**
 * Resolve a shared-runtime navigation directive from the user's message, or null
 * when the message is not an unambiguous in-app navigation command (the vast
 * majority of turns — those fall through to the normal LLM reply unchanged).
 *
 * Order: the voice-settings special case first (it is a settings deep-link the
 * bare matcher would otherwise route to plain settings without the section),
 * then the general rigid matcher.
 */
export function resolveSharedNavIntent(
  message: string | undefined,
): SharedNavIntent | null {
  const text = (message ?? "").trim();
  if (!text) return null;

  // Voice-settings deep-link: "change my voice" → Settings › Voice.
  if (VOICE_SETTINGS_INTENT.test(text)) {
    const label = "Voice settings";
    return {
      viewId: "settings",
      subview: "voice",
      label,
      reply: navReply(label),
    };
  }

  const viewId = matchViewCommand(text);
  if (!viewId) return null;

  const label = NAVIGABLE_VIEW_LABELS[viewId];
  // A matcher id we don't have a builtin label/surface for (should not happen
  // given the table mirrors MATCHER_VIEW_IDS) is left to the LLM rather than
  // navigating into a surface the client can't resolve.
  if (!label) return null;

  return { viewId, label, reply: navReply(label) };
}

/**
 * The VIEWS action-result summary a navigation directive attaches to the turn's
 * `done` SSE frame. Shape MUST match `ChatActionResultSummary` +
 * `findViewActionHandoff` in packages/ui: actionName "VIEWS", success true,
 * values.mode "show", values.viewId (+ optional values.subview). The PWA's
 * `dispatchViewActionHandoff` reads exactly these fields to fire the client
 * navigate event.
 */
export function navIntentActionResult(intent: SharedNavIntent): {
  actionName: "VIEWS";
  success: true;
  text: string;
  values: { mode: "show"; viewId: string; subview?: string; source: "agent" };
} {
  return {
    actionName: "VIEWS",
    success: true,
    text: intent.reply,
    values: {
      mode: "show",
      viewId: intent.viewId,
      ...(intent.subview ? { subview: intent.subview } : {}),
      source: "agent",
    },
  };
}
