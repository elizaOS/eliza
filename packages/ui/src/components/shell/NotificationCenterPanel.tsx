import { ChevronUp } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { NotificationCenter } from "./NotificationCenter";

/**
 * The pulled-down notification center (#10706): an iOS-style panel that slides
 * in from the top of the shell when the user pulls DOWN on the home widget area
 * (see HomeScreen's pull-down gesture, distinct from the chat sheet's bottom
 * grabber). It hosts the full `NotificationCenter` in panel mode — the list plus
 * the priority↔time sort toggle — with a backdrop and a close affordance.
 *
 * The `NotificationCenter` inside mounts only while `isOpen`, so the always-on
 * headless `<NotificationCenter headless />` in the shell stays responsible for
 * booting the store + toast routing when the panel is closed.
 */
export function NotificationCenterPanel({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}): ReactNode {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          key="notification-center-panel-overlay"
          className="fixed inset-0 z-[70] flex flex-col"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.18 }}
        >
          {/* Backdrop — tap to dismiss. */}
          <button
            type="button"
            aria-label="Close notifications"
            data-testid="notification-center-backdrop"
            onClick={onClose}
            className="absolute inset-0 h-full w-full cursor-default bg-bg/60 backdrop-blur-sm"
          />
          <motion.div
            className={cn(
              "relative z-[1] mx-auto flex max-h-[min(85vh,640px)] w-full max-w-lg flex-col",
              "mt-[calc(var(--safe-area-top,0px)+0.5rem)] overflow-hidden",
              "rounded-b-2xl border border-t-0 border-border bg-card shadow-xl",
            )}
            initial={{ y: reduceMotion ? 0 : "-100%" }}
            animate={{ y: 0 }}
            exit={{ y: reduceMotion ? 0 : "-100%" }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 420, damping: 40 }
            }
          >
            <NotificationCenter isPanelMode onNavigate={onClose} />
            {/* Grab-handle / close affordance at the bottom of the panel. */}
            <button
              type="button"
              aria-label="Close notifications"
              data-testid="notification-center-close"
              onClick={onClose}
              className="flex shrink-0 items-center justify-center gap-1.5 border-t border-border py-2 text-xs font-medium text-muted-strong transition-colors hover:bg-surface hover:text-txt"
            >
              <ChevronUp className="h-4 w-4" aria-hidden />
              <span>Close</span>
            </button>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export default NotificationCenterPanel;
