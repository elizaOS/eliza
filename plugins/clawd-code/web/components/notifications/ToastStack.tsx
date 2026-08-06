"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Toast } from "./Toast";
import { useNotificationStore } from "@/lib/notifications";

export function ToastStack() {
  const toasts = useNotificationStore((s) => s.toasts);
  const dismissToast = useNotificationStore((s) => s.dismissToast);

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, x: 80, scale: 0.92 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 80, scale: 0.92, transition: { duration: 0.15 } }}
            transition={{ type: "spring", stiffness: 380, damping: 28 }}
          >
            <Toast toast={toast} onDismiss={dismissToast} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
