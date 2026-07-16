/**
 * The composer-bridge state machine: fold one decoded {@link ComposerOperation}
 * into the reduced {@link ComposerDraft} and answer with a typed
 * {@link DispatchResult}. This reducer IS the contract's behavioral spec for
 * idempotency, cancellation, offline deferral, and permission/limit enforcement.
 *
 * The guarantees, all decided from structural fields (the `opId` key, the op
 * `type`, the online flag, and capability/limit context) — never from inspecting
 * text content:
 *   - Idempotency: `opId` is unique per stream; an op whose `opId` has already
 *     produced an applied mutation is a no-op, reported `duplicate`. This is what
 *     makes a duplicate native callback, or a replay after reconnect/reload,
 *     safe.
 *   - Offline deferral: a `send` issued while `!online` is queued and reported
 *     `deferred`; `flushDeferredOperations` replays the queue on reconnect. Local
 *     draft edits never defer — they apply offline and are preserved.
 *   - Cancellation: `cancel` aborts the in-flight send (`scope: "send"`) or
 *     resets the draft body while keeping focus (`scope: "draft"`).
 *   - Permission/limits: an op needing an absent capability (`attach`/`voice`) is
 *     `rejected: "permission-denied"`; over-cap text/attachments/bytes are
 *     `rejected: "oversized"`; a malformed attachment source is
 *     `rejected: "invalid-input"`. A rejection is NOT recorded as processed, so a
 *     corrected retry re-evaluates.
 *
 * Callers pass only decoded operations (see `decode.ts`); this function trusts
 * the shapes and never re-validates them.
 */

import { normalizeComposerAttachment } from "./attachments";
import {
  type ComposerDraft,
  type ComposerOperation,
  type ComposerRejectReason,
  type DispatchResult,
  emptyComposerDraft,
  type SendOutcome,
} from "./contract";

/** Feature capabilities the shell currently grants; gate permissioned ops. */
export interface ComposerCapabilities {
  /** May add attachments (e.g. iOS photo-library permission granted). */
  attach: boolean;
  /** May hand off to voice (e.g. microphone permission granted). */
  voice: boolean;
}

/** Caps enforced by the reducer; over-cap input is rejected, never truncated. */
export interface ComposerLimits {
  maxTextLength: number;
  maxAttachments: number;
  maxAttachmentBytes: number;
  /** Cap on the dedupe ledger; the oldest ids evict past this (see note below). */
  maxProcessedOpIds: number;
}

export const DEFAULT_COMPOSER_CAPABILITIES: ComposerCapabilities = {
  attach: true,
  voice: true,
};

export const DEFAULT_COMPOSER_LIMITS: ComposerLimits = {
  maxTextLength: 100_000,
  maxAttachments: 10,
  maxAttachmentBytes: 50 * 1024 * 1024,
  maxProcessedOpIds: 512,
};

/** Per-apply context: transport liveness, granted capabilities, and caps. */
export interface ComposerApplyContext {
  online: boolean;
  capabilities: ComposerCapabilities;
  limits: ComposerLimits;
}

export function defaultApplyContext(
  online = true,
  overrides: Partial<ComposerApplyContext> = {},
): ComposerApplyContext {
  return {
    online,
    capabilities: overrides.capabilities ?? DEFAULT_COMPOSER_CAPABILITIES,
    limits: overrides.limits ?? DEFAULT_COMPOSER_LIMITS,
  };
}

/**
 * Reducer state. `processed` is the dedupe ledger of applied `opId`s; `deferred`
 * is the offline send queue; `sending` is the single in-flight send. Kept
 * separate from {@link ComposerDraft} so the draft the shell mirrors stays free
 * of bridge bookkeeping.
 */
export interface ComposerBridgeState {
  draft: ComposerDraft;
  processed: Set<string>;
  deferred: ComposerOperation[];
  sending: { opId: string } | null;
}

export function initialComposerState(): ComposerBridgeState {
  return {
    draft: emptyComposerDraft(),
    processed: new Set(),
    deferred: [],
    sending: null,
  };
}

/** Add `opId` to the ledger, evicting oldest ids past the cap (FIFO). */
function markProcessed(
  processed: Set<string>,
  opId: string,
  cap: number,
): Set<string> {
  const next = new Set(processed);
  next.add(opId);
  if (next.size > cap) {
    const keys = [...next];
    for (let i = 0; i < keys.length - cap; i++) next.delete(keys[i]);
  }
  return next;
}

/** Next draft with `patch` applied and `revision` bumped (an applied mutation). */
function bumpDraft(draft: ComposerDraft, patch: Partial<ComposerDraft>): ComposerDraft {
  return { ...draft, ...patch, revision: draft.revision + 1 };
}

function applied(state: ComposerBridgeState, opId: string): {
  state: ComposerBridgeState;
  result: DispatchResult;
} {
  return { state, result: { status: "applied", opId, draft: state.draft } };
}

function rejected(
  state: ComposerBridgeState,
  opId: string,
  reason: ComposerRejectReason,
  message: string,
): { state: ComposerBridgeState; result: DispatchResult } {
  return {
    state,
    result: { status: "rejected", opId, reason, message, draft: state.draft },
  };
}

/** True when the draft carries nothing sendable (blank text, no attachments). */
function isDraftEmpty(draft: ComposerDraft): boolean {
  return draft.text.trim().length === 0 && draft.attachments.length === 0;
}

/**
 * Fold one decoded operation into the state, returning the next state and the
 * typed {@link DispatchResult}. Pure: the input state is never mutated.
 */
export function applyComposerOperation(
  state: ComposerBridgeState,
  op: ComposerOperation,
  ctx: ComposerApplyContext,
): { state: ComposerBridgeState; result: DispatchResult } {
  // Idempotency: an op we have already applied is a no-op. This is the guard
  // that makes duplicate native callbacks and post-reconnect replays safe.
  if (state.processed.has(op.opId)) {
    return {
      state,
      result: { status: "duplicate", opId: op.opId, draft: state.draft },
    };
  }

  const { limits, capabilities, online } = ctx;

  // Compute the mutation (or a rejection) per op type; commit the processed-ledger
  // update only for the paths that actually apply.
  switch (op.type) {
    case "text.insert": {
      const text = state.draft.text + op.text;
      if (text.length > limits.maxTextLength)
        return rejected(state, op.opId, "oversized", "text exceeds max length");
      return commitApplied(state, op.opId, limits, bumpDraft(state.draft, { text }));
    }
    case "text.set": {
      if (op.text.length > limits.maxTextLength)
        return rejected(state, op.opId, "oversized", "text exceeds max length");
      return commitApplied(
        state,
        op.opId,
        limits,
        bumpDraft(state.draft, { text: op.text }),
      );
    }
    case "attachment.add": {
      if (!capabilities.attach)
        return rejected(state, op.opId, "permission-denied", "attach not permitted");
      const existingIdx = state.draft.attachments.findIndex(
        (a) => a.id === op.attachmentId,
      );
      if (existingIdx < 0 && state.draft.attachments.length >= limits.maxAttachments)
        return rejected(state, op.opId, "oversized", "too many attachments");
      const normalized = normalizeComposerAttachment(op.attachmentId, op.attachment, {
        maxBytes: limits.maxAttachmentBytes,
      });
      if (!normalized.ok)
        return rejected(state, op.opId, normalized.reason, normalized.message);
      const attachments = [...state.draft.attachments];
      if (existingIdx >= 0) attachments[existingIdx] = normalized.attachment;
      else attachments.push(normalized.attachment);
      return commitApplied(
        state,
        op.opId,
        limits,
        bumpDraft(state.draft, { attachments }),
      );
    }
    case "attachment.remove": {
      const attachments = state.draft.attachments.filter(
        (a) => a.id !== op.attachmentId,
      );
      return commitApplied(
        state,
        op.opId,
        limits,
        bumpDraft(state.draft, { attachments }),
      );
    }
    case "reply.set":
      return commitApplied(
        state,
        op.opId,
        limits,
        bumpDraft(state.draft, { reply: op.reply }),
      );
    case "reply.clear":
      return commitApplied(
        state,
        op.opId,
        limits,
        bumpDraft(state.draft, { reply: null }),
      );
    case "mention.add": {
      const token = `@${op.mention.label} `;
      const text = state.draft.text + token;
      if (text.length > limits.maxTextLength)
        return rejected(state, op.opId, "oversized", "text exceeds max length");
      return commitApplied(
        state,
        op.opId,
        limits,
        bumpDraft(state.draft, {
          text,
          mentions: [...state.draft.mentions, op.mention],
        }),
      );
    }
    case "focus.set": {
      const keyboard =
        op.keyboard ?? (op.focused ? "shown" : state.draft.keyboard);
      return commitApplied(
        state,
        op.opId,
        limits,
        bumpDraft(state.draft, { focused: op.focused, keyboard }),
      );
    }
    case "voice.handoff": {
      if (!capabilities.voice)
        return rejected(state, op.opId, "permission-denied", "voice not permitted");
      if (op.phase === "commit" && op.transcript) {
        const text = state.draft.text + op.transcript;
        if (text.length > limits.maxTextLength)
          return rejected(state, op.opId, "oversized", "text exceeds max length");
        return commitApplied(state, op.opId, limits, bumpDraft(state.draft, { text }));
      }
      // start/cancel carry no draft mutation; still recorded so a replay no-ops.
      return commitApplied(state, op.opId, limits, state.draft);
    }
    case "cancel": {
      if (op.scope === "send") {
        // Aborting a send is idempotent even with nothing in flight.
        return commitApplied(state, op.opId, limits, state.draft, { sending: null });
      }
      // scope === "draft": clear the body, keep focus/keyboard so the input stays live.
      const cleared: ComposerDraft = {
        ...emptyComposerDraft(),
        focused: state.draft.focused,
        keyboard: state.draft.keyboard,
        revision: state.draft.revision + 1,
      };
      return commitApplied(state, op.opId, limits, cleared, { sending: null });
    }
    case "send": {
      if (isDraftEmpty(state.draft))
        return rejected(state, op.opId, "empty-send", "nothing to send");
      if (state.sending)
        return rejected(state, op.opId, "send-in-flight", "a send is already in flight");
      if (!online) {
        // Queue for replay on reconnect; not marked processed until it applies.
        return {
          state: { ...state, deferred: [...state.deferred, op] },
          result: { status: "deferred", opId: op.opId, draft: state.draft },
        };
      }
      return commitApplied(state, op.opId, limits, state.draft, {
        sending: { opId: op.opId },
      });
    }
  }
}

/** Commit an applied mutation: record the opId and thread optional field patches. */
function commitApplied(
  state: ComposerBridgeState,
  opId: string,
  limits: ComposerLimits,
  draft: ComposerDraft,
  extra: Partial<Pick<ComposerBridgeState, "sending">> = {},
): { state: ComposerBridgeState; result: DispatchResult } {
  const next: ComposerBridgeState = {
    ...state,
    draft,
    processed: markProcessed(state.processed, opId, limits.maxProcessedOpIds),
    ...extra,
  };
  return { state: next, result: { status: "applied", opId, draft } };
}

/**
 * Resolve the in-flight send once its {@link SendOutcome} is known. On success
 * the draft is cleared (the message left the composer); on failure the draft is
 * kept so the user can retry. A stale resolution (no matching in-flight send) is
 * a no-op.
 */
export function resolveSend(
  state: ComposerBridgeState,
  opId: string,
  outcome: SendOutcome,
): ComposerBridgeState {
  if (!state.sending || state.sending.opId !== opId) return state;
  if (!outcome.ok) return { ...state, sending: null };
  return {
    ...state,
    sending: null,
    draft: { ...emptyComposerDraft(), revision: state.draft.revision + 1 },
  };
}

/**
 * Replay the offline send queue when the transport is back online. Each queued
 * op is re-applied through {@link applyComposerOperation}; the queue is cleared
 * (ops that still defer — should not happen when `ctx.online` — are re-queued by
 * apply). Returns the folded state and the per-op results in replay order.
 */
export function flushDeferredOperations(
  state: ComposerBridgeState,
  ctx: ComposerApplyContext,
): { state: ComposerBridgeState; results: DispatchResult[] } {
  const queue = state.deferred;
  let next: ComposerBridgeState = { ...state, deferred: [] };
  const results: DispatchResult[] = [];
  for (const op of queue) {
    const step = applyComposerOperation(next, op, ctx);
    next = step.state;
    results.push(step.result);
  }
  return { state: next, results };
}
