/**
 * The one cross-platform composer-bridge contract (`eliza.native-composer/v1`):
 * how an iOS (share sheet, keyboard extension, App Intent), Android (share
 * intent, quick-tile), or desktop (global hotkey, tray, menu) shell pushes
 * content INTO the chat composer and drives it, and how the renderer reports the
 * composer's state back so the shell stays in sync.
 *
 * Two typed, versioned, discriminated-union logs cross the boundary:
 *   - `ComposerOperation` (native shell → renderer): the commands — text,
 *     attachments, mentions, reply context, send/cancel, focus/keyboard, and
 *     voice handoff. Applying one returns a typed {@link DispatchResult}, never a
 *     bare boolean, so the shell learns *why* an op did nothing.
 *   - `ComposerEvent` (renderer → native shell): the composer's own state — the
 *     reduced draft, send outcomes, focus/keyboard, and voice-handoff phase.
 *
 * Design rules that make the bridge safe across a lossy, duplicating transport:
 *   - Every operation carries a stable, source-assigned `opId`. It is the sole
 *     idempotency key: a re-delivered op (duplicate native callback, replay after
 *     reconnect/reload) with an already-seen `opId` is a no-op, reported as
 *     `status: "duplicate"`. Behavior derives from this structural id, never from
 *     inspecting text content or its length.
 *   - Attachments are expressed only in the vocabulary of the existing
 *     content-addressed media store — inline bytes, a `data:` URL, a remote
 *     http(s) URL to SSRF-guard, or an already-stored `/api/media/<hash>` URL.
 *     There is deliberately no file-id / handle variant, so the contract cannot
 *     express a second file store (repo commandment; see media-store.ts).
 *
 * This module is pure type + constant declarations (runtime validation lives in
 * `decode.ts`, the state machine in `reduce.ts`) so it is safe to import from any
 * layer, native bridge shim included.
 */

/** Versioned schema identifier carried by a composer-bridge stream envelope. */
export const NATIVE_COMPOSER_SCHEMA = "eliza.native-composer/v1" as const;
export type NativeComposerSchema = typeof NATIVE_COMPOSER_SCHEMA;

// ── Shared value objects ───────────────────────────────────────────────

/** Whether the on-screen keyboard is up; drives layout the shell reports. */
export type KeyboardVisibility = "shown" | "hidden";

/**
 * How a native shell hands over one attachment, in media-store vocabulary only.
 * `inline`/`data-url` carry bytes to persist; `remote` is an http(s) URL the
 * server rehosts through the SSRF guard; `stored` is already in the store. No
 * variant carries a file id — the store is content-addressed by sha256 and a
 * second-store handle is unrepresentable here by design.
 */
export type ComposerAttachmentSource =
  | {
      source: "inline";
      mimeType: string;
      /** Raw bytes, base64 with no `data:` prefix. */
      bytesBase64: string;
      name?: string;
    }
  | { source: "data-url"; dataUrl: string; name?: string }
  | { source: "remote"; url: string; mimeType?: string; name?: string }
  | { source: "stored"; url: string; mimeType?: string; name?: string };

/** A reply/quote target the composer threads onto the outgoing message. */
export interface ComposerReplyContext {
  messageId: string;
  authorId?: string;
  /** Short preview text the composer renders in the reply chip. */
  preview?: string;
}

/** An @-mention token inserted into the draft. */
export interface ComposerMention {
  id: string;
  label: string;
  kind?: "user" | "agent" | "channel";
}

/** Scope of a `cancel` operation: abort an in-flight send, or clear the draft. */
export type ComposerCancelScope = "send" | "draft";

/** Lifecycle of a voice handoff: begin dictation, commit its text, or abandon. */
export type VoiceHandoffPhase = "start" | "commit" | "cancel";

// ── Operations (native shell → renderer) ───────────────────────────────

interface ComposerOperationBase {
  /** Stable, source-assigned idempotency key; a repeat is a no-op. */
  opId: string;
  /** Optional wall-clock ms of when the shell issued the op (display only). */
  at?: number;
}

/** Insert text at the caret (append semantics in a headless draft). */
export interface TextInsertOperation extends ComposerOperationBase {
  type: "text.insert";
  text: string;
}

/** Replace the whole draft text. */
export interface TextSetOperation extends ComposerOperationBase {
  type: "text.set";
  text: string;
}

/** Attach one piece of media, described in media-store vocabulary. */
export interface AttachmentAddOperation extends ComposerOperationBase {
  type: "attachment.add";
  /** Stable attachment id so a duplicate add and a later remove are addressable. */
  attachmentId: string;
  attachment: ComposerAttachmentSource;
}

/** Remove a previously-added attachment by its id. */
export interface AttachmentRemoveOperation extends ComposerOperationBase {
  type: "attachment.remove";
  attachmentId: string;
}

/** Set the reply/quote target for the next send. */
export interface ReplySetOperation extends ComposerOperationBase {
  type: "reply.set";
  reply: ComposerReplyContext;
}

/** Clear the reply/quote target. */
export interface ReplyClearOperation extends ComposerOperationBase {
  type: "reply.clear";
}

/** Insert an @-mention token into the draft. */
export interface MentionAddOperation extends ComposerOperationBase {
  type: "mention.add";
  mention: ComposerMention;
}

/** Submit the current draft. */
export interface SendOperation extends ComposerOperationBase {
  type: "send";
}

/** Cancel an in-flight send (`scope: "send"`) or clear the draft (`"draft"`). */
export interface CancelOperation extends ComposerOperationBase {
  type: "cancel";
  scope: ComposerCancelScope;
}

/** Set focus + report keyboard visibility. */
export interface FocusSetOperation extends ComposerOperationBase {
  type: "focus.set";
  focused: boolean;
  keyboard?: KeyboardVisibility;
}

/** Drive a voice handoff; `commit` carries the recognized transcript. */
export interface VoiceHandoffOperation extends ComposerOperationBase {
  type: "voice.handoff";
  phase: VoiceHandoffPhase;
  transcript?: string;
}

export type ComposerOperation =
  | TextInsertOperation
  | TextSetOperation
  | AttachmentAddOperation
  | AttachmentRemoveOperation
  | ReplySetOperation
  | ReplyClearOperation
  | MentionAddOperation
  | SendOperation
  | CancelOperation
  | FocusSetOperation
  | VoiceHandoffOperation;

export type ComposerOperationType = ComposerOperation["type"];

/** Every recognized operation discriminant, for the decoder's known-type gate. */
export const COMPOSER_OPERATION_TYPES: readonly ComposerOperationType[] = [
  "text.insert",
  "text.set",
  "attachment.add",
  "attachment.remove",
  "reply.set",
  "reply.clear",
  "mention.add",
  "send",
  "cancel",
  "focus.set",
  "voice.handoff",
] as const;

/** Stream envelope: the versioned schema tag plus the ordered operation log. */
export interface ComposerOperationStream {
  schema: NativeComposerSchema;
  operations: ComposerOperation[];
}

// ── Reduced draft model (what the renderer holds, the shell mirrors) ────

/**
 * A resolved attachment reference in the draft, in media-store vocabulary. An
 * `inline`/`data-url` source normalizes to a `data:` URL the existing outgoing
 * pipeline persists to the content-addressed store on send; `remote` is rehosted
 * SSRF-guarded server-side; `stored` passes through. `kind` records that routing.
 * No field is a file id.
 */
export interface ComposerAttachment {
  id: string;
  /** `data:`, remote http(s), or `/api/media/<hash>` URL — the store's handle. */
  url: string;
  mimeType?: string;
  name?: string;
  /** Store-routing kind: inline bytes, a remote URL to rehost, or already stored. */
  kind: "inline" | "remote" | "stored";
  /**
   * `ready` = usable as-is; `pending-rehost` = a remote URL awaiting server-side
   * SSRF rehost on send. There is no `failed` success-substitute: a source that
   * fails validation never becomes an attachment (the op is rejected instead).
   */
  status: "ready" | "pending-rehost";
}

/**
 * The reduced composer draft. `revision` bumps on every applied mutation so the
 * shell can diff and a reload can detect staleness; it is the durable state the
 * bridge preserves across backgrounding, reload, and reconnect.
 */
export interface ComposerDraft {
  text: string;
  attachments: ComposerAttachment[];
  reply: ComposerReplyContext | null;
  mentions: ComposerMention[];
  focused: boolean;
  keyboard: KeyboardVisibility;
  revision: number;
}

/** The empty draft a fresh composer starts from. */
export function emptyComposerDraft(): ComposerDraft {
  return {
    text: "",
    attachments: [],
    reply: null,
    mentions: [],
    focused: false,
    keyboard: "hidden",
    revision: 0,
  };
}

// ── Dispatch result (the typed answer to applying an operation) ─────────

/** Why an operation was rejected — a closed, machine-readable set. */
export type ComposerRejectReason =
  | "permission-denied"
  | "invalid-input"
  | "oversized"
  | "unsupported"
  | "no-active-composer"
  | "empty-send"
  | "send-in-flight";

/**
 * The typed result of applying one operation — never a bare boolean. `applied`
 * mutated the draft; `duplicate` is the idempotent no-op for an already-seen
 * `opId`; `deferred` was queued because the transport is offline (replayed on
 * reconnect); `rejected` carries a typed reason. Every variant echoes the draft
 * so the caller always has the current state.
 */
export type DispatchResult =
  | { status: "applied"; opId: string; draft: ComposerDraft }
  | { status: "duplicate"; opId: string; draft: ComposerDraft }
  | { status: "deferred"; opId: string; draft: ComposerDraft }
  | {
      status: "rejected";
      opId: string;
      reason: ComposerRejectReason;
      message: string;
      draft: ComposerDraft;
    };

/** Outcome of a submitted send, surfaced back to the shell. */
export type SendOutcome =
  | { ok: true; messageId: string }
  | { ok: false; reason: ComposerRejectReason; message: string };

// ── Events (renderer → native shell) ───────────────────────────────────

/** The reduced draft changed; the shell re-renders its mirror. */
export interface DraftChangedEvent {
  type: "draft.changed";
  draft: ComposerDraft;
}

/** A send that the shell initiated resolved. */
export interface SendResultEvent {
  type: "send.result";
  opId: string;
  outcome: SendOutcome;
}

/** Focus/keyboard state changed (e.g. the user dismissed the keyboard). */
export interface FocusChangedEvent {
  type: "focus.changed";
  focused: boolean;
  keyboard: KeyboardVisibility;
}

/** The voice-handoff phase advanced. */
export interface VoiceHandoffStateEvent {
  type: "voice.state";
  phase: VoiceHandoffPhase;
}

export type ComposerEvent =
  | DraftChangedEvent
  | SendResultEvent
  | FocusChangedEvent
  | VoiceHandoffStateEvent;

export type ComposerEventType = ComposerEvent["type"];

/** Every recognized event discriminant, for the decoder's known-type gate. */
export const COMPOSER_EVENT_TYPES: readonly ComposerEventType[] = [
  "draft.changed",
  "send.result",
  "focus.changed",
  "voice.state",
] as const;
