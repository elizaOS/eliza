/** Coalesces streaming text, tool events, and status without losing terminal snapshots. */

import type { ChatToolCallEvent, ChatTurnStatus } from "@elizaos/contracts";
import { useCallback, useEffect, useRef } from "react";
import { streamingRenderDelayMs } from "./streaming-render-cadence";
import type { StreamingTextModification } from "./useStreamingText";

const NO_PENDING_STATUS = Symbol("no-pending-status");
interface StreamingChatBufferOptions {
  applyModification: (
    conversationId: string | null,
    modification: StreamingTextModification,
  ) => void;
  isConversationCommitActive: (conversationId: string | null) => boolean;
  setServerTurnStatus: (status: ChatTurnStatus | null) => void;
}
export function useStreamingChatBuffer({
  applyModification,
  isConversationCommitActive,
  setServerTurnStatus,
}: StreamingChatBufferOptions) {
  // Streaming-paint coalescer.
  // The SSE stream fires three per-event callbacks that each trigger a state
  // commit: `onToken` (cumulative text, often >60/sec on a fast model),
  // `onStatus` (live turn phase), and `onToolEvent` (inline tool-call steps).
  // A microtask merges callbacks decoded from one transport event, but a fast
  // model still delivers separate events faster than the full chat overlay can
  // render them. Park cumulative snapshots and paint the first one immediately,
  // then at a bounded cadence. Terminal/abort paths synchronously flush the
  // latest snapshot, so throttling cannot lose text. A timeout is the delivery
  // clock rather than rAF because hidden/resource-constrained tabs may defer
  // animation frames for seconds.
  //
  // `pendingStatus` uses the NO_PENDING_STATUS sentinel = "no status update
  // parked", distinct from a parked `null` (an explicit clear-the-status
  // commit).
  const streamingFlushRef = useRef<{
    conversationId: string | null;
    messageId: string;
    pendingText: string | null;
    /** Whether the parked text is action-callback (provisional) text — the
     *  latest frame wins, mirroring `pendingText` (double-speak fix). */
    pendingTextProvisional: boolean;
    pendingStatus: ChatTurnStatus | null | typeof NO_PENDING_STATUS;
    pendingToolEvents: ChatToolCallEvent[];
    flushScheduled: boolean;
    flushGeneration: number;
    flushTimer: ReturnType<typeof setTimeout> | null;
    lastFlushAtMs: number | null;
  }>({
    conversationId: null,
    messageId: "",
    pendingText: null,
    pendingTextProvisional: false,
    pendingStatus: NO_PENDING_STATUS,
    pendingToolEvents: [],
    flushScheduled: false,
    flushGeneration: 0,
    flushTimer: null,
    lastFlushAtMs: null,
  });
  // Commit whatever text/status/tool events are parked for the in-flight turn in
  // one pass, then clear the pending slots. Order matters: tool events merge
  // onto the same turn as the text, and the status is a sibling indicator — all
  // three settle together so the commit reflects one coherent stream state.
  // Safe to call when nothing is pending (no-op).
  const commitStreamingBuffer = useCallback(() => {
    const buffer = streamingFlushRef.current;
    const commitVisible = isConversationCommitActive(buffer.conversationId);
    let committed = false;
    if (buffer.pendingText !== null) {
      const fullText = buffer.pendingText;
      const provisional = buffer.pendingTextProvisional;
      buffer.pendingText = null;
      buffer.pendingTextProvisional = false;
      const modification: StreamingTextModification = {
        messageId: buffer.messageId,
        mode: "replace",
        fullText,
        provisional,
      };
      applyModification(buffer.conversationId, modification);
      committed = true;
    }
    if (buffer.pendingToolEvents.length > 0) {
      const toolEvents = buffer.pendingToolEvents;
      buffer.pendingToolEvents = [];
      for (const event of toolEvents) {
        const modification: StreamingTextModification = {
          messageId: buffer.messageId,
          mode: "tool",
          event,
        };
        applyModification(buffer.conversationId, modification);
      }
      committed = true;
    }
    if (buffer.pendingStatus !== NO_PENDING_STATUS) {
      const status = buffer.pendingStatus;
      buffer.pendingStatus = NO_PENDING_STATUS;
      if (commitVisible) {
        setServerTurnStatus(status);
        committed = true;
      }
    }
    if (committed) buffer.lastFlushAtMs = performance.now();
  }, [applyModification, isConversationCommitActive, setServerTurnStatus]);
  // Apply whatever streaming state is parked for the in-flight turn NOW and
  // invalidate its pending microtask/timer. Called before every terminal/abort
  // transition so no token, tool row, or status is lost.
  const flushStreamingText = useCallback(() => {
    const buffer = streamingFlushRef.current;
    if (buffer.flushScheduled) {
      buffer.flushGeneration += 1;
      buffer.flushScheduled = false;
    }
    if (buffer.flushTimer !== null) {
      clearTimeout(buffer.flushTimer);
      buffer.flushTimer = null;
    }
    commitStreamingBuffer();
  }, [commitStreamingBuffer]);
  // Reset the buffer to a fresh turn when `messageId` changes, dropping any
  // stale parked state (text/status/tool) from the prior turn. Runs BEFORE a
  // scheduler parks its value, so the reset never clobbers the value just set.
  const startStreamingTurn = useCallback(
    (conversationId: string, messageId: string) => {
      const buffer = streamingFlushRef.current;
      if (
        buffer.conversationId === conversationId &&
        buffer.messageId === messageId
      )
        return;
      if (buffer.flushScheduled) buffer.flushGeneration += 1;
      if (buffer.flushTimer !== null) {
        clearTimeout(buffer.flushTimer);
        buffer.flushTimer = null;
      }
      buffer.conversationId = conversationId;
      buffer.messageId = messageId;
      buffer.pendingText = null;
      buffer.pendingTextProvisional = false;
      buffer.pendingStatus = NO_PENDING_STATUS;
      buffer.pendingToolEvents = [];
      buffer.flushScheduled = false;
      buffer.lastFlushAtMs = null;
    },
    [],
  );
  // The first snapshot paints in a microtask; later snapshots within the
  // cadence window share one trailing timer and overwrite the cumulative text.
  const ensureStreamingFlush = useCallback(() => {
    const buffer = streamingFlushRef.current;
    if (buffer.flushScheduled) return;
    buffer.flushScheduled = true;
    const generation = buffer.flushGeneration;
    const commitScheduled = () => {
      if (buffer.flushGeneration !== generation) return;
      buffer.flushTimer = null;
      buffer.flushScheduled = false;
      commitStreamingBuffer();
    };
    const delayMs = streamingRenderDelayMs(
      buffer.lastFlushAtMs,
      performance.now(),
    );
    if (delayMs === 0) {
      queueMicrotask(commitScheduled);
      return;
    }
    buffer.flushTimer = setTimeout(commitScheduled, delayMs);
  }, [commitStreamingBuffer]);
  // Park the latest cumulative text for `messageId`. Synchronous callbacks from
  // one decoded SSE batch overwrite the parked value and commit together.
  const scheduleStreamingText = useCallback(
    (
      conversationId: string,
      messageId: string,
      fullText: string,
      provisional = false,
    ) => {
      startStreamingTurn(conversationId, messageId);
      streamingFlushRef.current.pendingText = fullText;
      streamingFlushRef.current.pendingTextProvisional = provisional;
      ensureStreamingFlush();
    },
    [startStreamingTurn, ensureStreamingFlush],
  );
  // Park a live turn-status phase for `messageId`; the latest value wins within
  // one synchronous transport burst (superseded phases are never rendered).
  // Coalesced with text/tool events from that burst (#8813).
  const scheduleServerTurnStatus = useCallback(
    (
      conversationId: string,
      messageId: string,
      status: ChatTurnStatus | null,
    ) => {
      startStreamingTurn(conversationId, messageId);
      streamingFlushRef.current.pendingStatus = status;
      ensureStreamingFlush();
    },
    [startStreamingTurn, ensureStreamingFlush],
  );
  // Park one inline tool-call step for `messageId`. Unlike text/status these
  // ACCUMULATE within a transport burst — each step (call → result/error) is a distinct
  // merge onto the turn's `toolEvents`, so none may be dropped (#13535).
  const scheduleToolEvent = useCallback(
    (conversationId: string, messageId: string, event: ChatToolCallEvent) => {
      startStreamingTurn(conversationId, messageId);
      streamingFlushRef.current.pendingToolEvents.push(event);
      ensureStreamingFlush();
    },
    [startStreamingTurn, ensureStreamingFlush],
  );
  // Invalidate any queued flush on unmount so it cannot commit into a torn-down
  // tree.
  useEffect(() => {
    const buffer = streamingFlushRef.current;
    return () => {
      buffer.flushGeneration += 1;
      buffer.flushScheduled = false;
      if (buffer.flushTimer !== null) {
        clearTimeout(buffer.flushTimer);
        buffer.flushTimer = null;
      }
      buffer.pendingText = null;
      buffer.pendingTextProvisional = false;
      buffer.conversationId = null;
      buffer.pendingStatus = NO_PENDING_STATUS;
      buffer.pendingToolEvents = [];
    };
  }, []);
  return {
    flushStreamingText,
    scheduleStreamingText,
    scheduleServerTurnStatus,
    scheduleToolEvent,
  };
}
