import { RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { Z_SYSTEM_BANNER } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import {
  type ConversationUndoRequest,
  dismissConversationUndo,
  getConversationUndoSnapshot,
  subscribeConversationUndo,
} from "./conversation-undo-store";
import { usePullGesture } from "./use-pull-gesture";

/** How long the undo affordance stays before auto-dismissing. */
const UNDO_DURATION_MS = 3000;

/**
 * Glassmorphic "Conversation cleared — Undo" toast (#8929).
 *
 * Mounted once at the app root; driven by the conversation-undo store. Restores
 * the previous conversation on tap (Undo button) or a left-swipe, and
 * auto-dismisses after {@link UNDO_DURATION_MS}. Re-arms the timer whenever a
 * new request arrives (its `id` changes).
 */
export function ConversationUndoToast(): React.JSX.Element {
  const request = React.useSyncExternalStore(
    subscribeConversationUndo,
    getConversationUndoSnapshot,
    () => null,
  );

  return (
    <div
      // Sit ABOVE the bottom composer/input bar (always present in the chat
      // surfaces) so the toast never visually overlaps it, AND layer above the
      // shell overlay (z 9000) so its thread-lines/composer don't intercept the
      // pointer — otherwise "Undo" can't be reached.
      className="pointer-events-none fixed inset-x-0 bottom-[max(6rem,calc(env(safe-area-inset-bottom,0px)+5.5rem))] flex justify-center px-4"
      style={{ zIndex: Z_SYSTEM_BANNER }}
      aria-live="polite"
    >
      <AnimatePresence>
        {request ? <UndoToastCard key={request.id} request={request} /> : null}
      </AnimatePresence>
    </div>
  );
}

function UndoToastCard({
  request,
}: {
  request: ConversationUndoRequest;
}): React.JSX.Element {
  const restore = React.useCallback(() => {
    request.onUndo();
    dismissConversationUndo(request.id);
  }, [request]);

  // Auto-dismiss after the grace window, but PAUSE while the pointer is over the
  // toast or it holds focus — so reaching for "Undo" never makes it vanish
  // mid-reach (standard toast UX; also keeps the affordance interactable).
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  const startTimer = React.useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(
      () => dismissConversationUndo(request.id),
      UNDO_DURATION_MS,
    );
  }, [clearTimer, request.id]);
  React.useEffect(() => {
    startTimer();
    return clearTimer;
  }, [startTimer, clearTimer]);

  // Swipe the toast LEFT to restore (mirrors the conversation swipe gesture).
  const swipe = usePullGesture({
    onSwipeLeft: restore,
    onSwipeRight: () => dismissConversationUndo(request.id),
  });

  return (
    <motion.div
      data-testid="conversation-undo-toast"
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 16, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      className={cn(
        "pointer-events-auto flex items-center gap-3 rounded-full px-4 py-2.5",
        "border border-white/15 bg-black/70 text-white/90 shadow-2xl backdrop-blur-xl",
        "touch-pan-y select-none",
      )}
      onPointerEnter={clearTimer}
      onPointerLeave={startTimer}
      onFocusCapture={clearTimer}
      onBlurCapture={startTimer}
      {...swipe}
    >
      <RotateCcw className="h-4 w-4 shrink-0 text-white/55" aria-hidden />
      <span className="text-sm text-white/80">{request.label}</span>
      <button
        type="button"
        data-testid="conversation-undo-button"
        onClick={restore}
        className={cn(
          "rounded-full px-3 py-1 text-sm font-medium transition-colors",
          "bg-white/10 text-white hover:bg-white/20",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
        )}
      >
        {request.actionLabel}
      </button>
    </motion.div>
  );
}
