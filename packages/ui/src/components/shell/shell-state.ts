/**
 * Defines shell reducer state for overlays, launcher mode, notifications, and
 * surface coordination.
 */
import type {
  ChatFailureKind,
  ConversationSecretRequest,
  MessageAttachment,
  NativeToolCallEvent,
} from "../../api";

/**
 * Shell phase for the device-shell foundation (HomePill + AssistantOverlay +
 * ChatSurface). Drives the pill's visual treatment.
 *
 *   booting    — startup not ready; pill dim, no halo.
 *   idle       — ready, no overlay; pill solid.
 *   summoned   — overlay open, no active mic/response; faint halo.
 *   listening  — push-to-talk capture in flight; red pulse.
 *   responding — agent stream in flight; ambient glow.
 */
export type ShellPhase =
  | "booting"
  | "idle"
  | "summoned"
  | "listening"
  | "responding";

export interface ShellMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /**
   * Message origin (e.g. "client_chat", "proactive-interaction"). Assistant
   * turns with source "proactive-interaction" render as dismissible/acceptable
   * suggestion bubbles (#8792).
   */
  source?: string;
  /** Set on assistant turns the server flagged as failed (e.g. no provider). */
  failureKind?: ChatFailureKind;
  /** Agent reasoning/thought for this turn, rendered as a collapsed block. */
  reasoning?: string;
  /** Inline tool-call rows for this turn, streamed live from the chat SSE `tool`
   *  events and rendered via ToolCallEventLog (#13535). */
  toolEvents?: NativeToolCallEvent[];
  /** Media attached to this turn — user uploads and agent-generated media. */
  attachments?: MessageAttachment[];
  /** Pending secret / OAuth request (rendered as an actionable block). */
  secretRequest?: ConversationSecretRequest;
  /**
   * Short topic labels for this turn (Stage-1 `topics`). Drives the transcript
   * topic grouping + chips bar (#8928). Absent when the turn had no topic.
   */
  topics?: string[];
}

/**
 * Max chat turns actually rendered in the shell transcript. Older turns stay in
 * state (the agent's context is untouched) — this only bounds DOM nodes so a
 * long thread can't jank scrolling, without pulling in a virtualizer. Gap 4 of
 * #9141 (transcript windowing) builds on this seam.
 */
export const MAX_RENDERED_SHELL_MESSAGES = 80;

/**
 * Pure transcript-windowing decision (#9141 gap 4 seam). Drops empty turns —
 * EXCEPT turns that carry non-text content (attachments or a pending secret
 * request: an image-only send is a valid user turn and an assistant reply can
 * be a bare generated image), a FAILED assistant turn (failureKind carries the
 * retry / no-provider / insufficient-credits UI, which is often content-less —
 * a rate-limit or provider stall fails before any token streams, so dropping
 * it would hide the failure AND its retry affordance entirely), and the
 * in-flight assistant turn while a reply is streaming (phase === "responding"),
 * so its bubble can show the breathing dots anchored where the text will fill
 * in — then keeps only the most recent `max` turns to bound DOM nodes. Pure +
 * DOM-free so the cap + exceptions are unit-testable and any future virtualizer
 * can reuse the same predicate.
 */
export function selectVisibleShellMessages(
  messages: readonly ShellMessage[],
  phase: ShellPhase,
  max: number = MAX_RENDERED_SHELL_MESSAGES,
): ShellMessage[] {
  const kept = messages.filter(
    (m) =>
      m.content.trim() ||
      (m.attachments?.length ?? 0) > 0 ||
      m.secretRequest !== undefined ||
      m.failureKind !== undefined ||
      (m.role === "assistant" && phase === "responding"),
  );
  return max > 0 && kept.length > max ? kept.slice(-max) : [...kept];
}
