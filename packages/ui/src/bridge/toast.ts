/**
 * Adapts Cloud feedback to the shell's native-first action-notice path.
 * Standalone Cloud pages retain Sonner as their viewport fallback. Interactive,
 * custom, and progress toasts stay in-app because OS alerts cannot execute
 * their React actions or represent their ongoing lifecycle.
 */
import { Capacitor } from "@capacitor/core";
import { toast as sonner } from "sonner";
import type { ActionTone } from "../state/action-notice";
import { getActionNoticeSink } from "../state/app-store";
import { isElectrobunRuntime } from "./electrobun-runtime";
import { deliverSystemNotification } from "./notification-delivery";

type ToastFunction = typeof sonner.success;
const pendingNative = new Set<string>();
let activeShellFeedback: { id: string; cancel: () => void } | null = null;

function feedback(fallback: ToastFunction, tone: ActionTone): ToastFunction {
  return (message, options) => {
    if (
      typeof message !== "string" ||
      (options?.description !== undefined &&
        typeof options.description !== "string") ||
      options?.action ||
      options?.cancel ||
      options?.onDismiss ||
      options?.onAutoClose ||
      options?.id !== undefined ||
      options?.duration === Infinity
    ) {
      return options === undefined
        ? fallback(message)
        : fallback(message, options);
    }
    const text = options?.description
      ? `${message}\n${options.description}`
      : message;
    const id = `feedback-${crypto.randomUUID()}`;
    const shellSink = getActionNoticeSink();
    if (shellSink) {
      const cancel = shellSink(text, tone, options?.duration);
      activeShellFeedback =
        typeof cancel === "function" ? { id, cancel } : null;
      return id;
    }
    if (!Capacitor.isNativePlatform() && !isElectrobunRuntime()) {
      return options === undefined
        ? fallback(message)
        : fallback(message, options);
    }
    pendingNative.add(id);
    void deliverSystemNotification({
      id,
      title: "Eliza",
      body: text,
      priority: tone === "error" ? "high" : "normal",
      requestPermission: false,
    }).then((channel) => {
      const active = pendingNative.delete(id);
      if (active && channel === "none") fallback(message, { ...options, id });
    });
    return id;
  };
}

export const toast: typeof sonner = Object.assign(
  feedback(sonner, "info"),
  sonner,
  {
    dismiss: (id?: number | string) => {
      if (id === undefined) pendingNative.clear();
      else pendingNative.delete(String(id));
      if (
        activeShellFeedback &&
        (id === undefined || activeShellFeedback.id === id)
      ) {
        activeShellFeedback.cancel();
        activeShellFeedback = null;
      }
      return sonner.dismiss(id);
    },
    success: feedback(sonner.success, "success"),
    error: feedback(sonner.error, "error"),
    info: feedback(sonner.info, "info"),
    warning: feedback(sonner.warning, "info"),
    message: feedback(sonner.message, "info"),
  },
);
