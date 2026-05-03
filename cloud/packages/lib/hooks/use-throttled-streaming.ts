"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Minimum interval between UI updates in milliseconds.
 * ~30fps feels smooth for text streaming while being efficient.
 * Too fast (60fps) = jittery appearance, too slow (15fps) = laggy feel.
 */
const MIN_UPDATE_INTERVAL_MS = 33; // ~30fps

/**
 * Pending update tracking with type discrimination.
 * Allows proper cleanup of both timeouts and animation frames.
 */
type PendingUpdate =
  | {
      type: "timeout";
      timeoutId: ReturnType<typeof setTimeout>;
      rafId?: number;
    }
  | { type: "raf"; frameId: number };

/**
 * Hook for throttled streaming updates with smooth visual pacing.
 *
 * WHY THIS EXISTS:
 * When streaming LLM responses, we receive many small chunks (often 1 token = ~4 chars each).
 * Without throttling, each chunk triggers a React re-render + array operations.
 * Example: 100 tokens/second = 100 re-renders/second = laggy UI.
 *
 * WHAT IT DOES:
 * - Accumulates chunks in a Map (no re-renders)
 * - Batches UI updates at ~30fps for smooth visual appearance
 * - Uses requestAnimationFrame for paint-synced updates
 * - Ensures minimum interval between updates for readable text flow
 *
 * VISUAL IMPACT:
 * Text appears to flow smoothly like a typewriter effect rather than
 * flooding in or updating jerkily. The pacing feels natural and readable.
 *
 * @example
 * const { accumulateChunk, scheduleUpdate, clearAll } = useThrottledStreamingUpdate();
 *
 * // On each chunk:
 * accumulateChunk(messageId, chunk);
 * scheduleUpdate(messageId, (text) => {
 *   setMessages(prev => updateStreamingMessage(prev, messageId, text));
 * });
 * // On completion:
 * clearAll();
 */
export function useThrottledStreamingUpdate() {
  // Map of messageId -> accumulated text (no re-renders when updated)
  const textMapRef = useRef<Map<string, string>>(new Map());

  // Map of messageId -> pending update info (for throttling)
  const pendingUpdatesRef = useRef<Map<string, PendingUpdate>>(new Map());

  // Map of messageId -> last update timestamp (for minimum interval enforcement)
  const lastUpdateTimeRef = useRef<Map<string, number>>(new Map());

  // Cleanup on unmount
  useEffect(() => {
    // Capture refs inside effect for cleanup
    const pendingUpdates = pendingUpdatesRef.current;
    const textMap = textMapRef.current;
    const lastUpdateTime = lastUpdateTimeRef.current;

    return () => {
      // Cancel all pending updates (both timeouts and animation frames)
      pendingUpdates.forEach((pending) => {
        if (pending.type === "timeout") {
          clearTimeout(pending.timeoutId);
          if (pending.rafId !== undefined) {
            cancelAnimationFrame(pending.rafId);
          }
        } else {
          cancelAnimationFrame(pending.frameId);
        }
      });
      pendingUpdates.clear();
      textMap.clear();
      lastUpdateTime.clear();
    };
  }, []);

  /**
   * Accumulate a chunk of text for a message (no re-render).
   */
  const accumulateChunk = useCallback((messageId: string, chunk: string) => {
    const currentText = textMapRef.current.get(messageId) || "";
    textMapRef.current.set(messageId, currentText + chunk);
  }, []);

  /**
   * Get the current accumulated text for a message (synchronous read).
   * Useful when you need to read the current state without triggering an update.
   */
  const getText = useCallback((messageId: string): string => {
    return textMapRef.current.get(messageId) || "";
  }, []);

  /**
   * Clear all accumulated text (call on error or reset).
   */
  const clearAll = useCallback(() => {
    textMapRef.current.clear();
    lastUpdateTimeRef.current.clear();
    pendingUpdatesRef.current.forEach((pending) => {
      if (pending.type === "timeout") {
        clearTimeout(pending.timeoutId);
        if (pending.rafId !== undefined) {
          cancelAnimationFrame(pending.rafId);
        }
      } else {
        cancelAnimationFrame(pending.frameId);
      }
    });
    pendingUpdatesRef.current.clear();
  }, []);

  /**
   * Schedule a throttled UI update for a message.
   * The callback receives the current accumulated text.
   * Updates are throttled to ~30fps for smooth visual appearance.
   */
  const scheduleUpdate = useCallback((messageId: string, onUpdate: (text: string) => void) => {
    // Skip if update already pending for this message
    if (pendingUpdatesRef.current.has(messageId)) {
      return;
    }

    const now = performance.now();
    const lastUpdate = lastUpdateTimeRef.current.get(messageId) || 0;
    const timeSinceLastUpdate = now - lastUpdate;

    // If we updated recently, delay this update
    if (timeSinceLastUpdate < MIN_UPDATE_INTERVAL_MS) {
      const delay = MIN_UPDATE_INTERVAL_MS - timeSinceLastUpdate;

      // Create the pending entry to track both timeout and future rAF
      const pendingEntry: PendingUpdate = {
        type: "timeout",
        timeoutId: setTimeout(() => {
          // Use rAF for paint-synced update
          const rafId = requestAnimationFrame(() => {
            // Only delete AFTER the rAF fires - this prevents race conditions
            pendingUpdatesRef.current.delete(messageId);
            lastUpdateTimeRef.current.set(messageId, performance.now());
            const text = textMapRef.current.get(messageId) || "";
            onUpdate(text);
          });
          // Track the rAF ID so it can be cancelled if clearAll is called
          const current = pendingUpdatesRef.current.get(messageId);
          if (current && current.type === "timeout") {
            current.rafId = rafId;
          }
        }, delay),
      };

      pendingUpdatesRef.current.set(messageId, pendingEntry);
      return;
    }

    // Schedule immediate rAF update
    const frameId = requestAnimationFrame(() => {
      pendingUpdatesRef.current.delete(messageId);
      lastUpdateTimeRef.current.set(messageId, performance.now());
      const text = textMapRef.current.get(messageId) || "";
      onUpdate(text);
    });

    pendingUpdatesRef.current.set(messageId, { type: "raf", frameId });
  }, []);

  return {
    accumulateChunk,
    clearAll,
    getText,
    scheduleUpdate,
  };
}
