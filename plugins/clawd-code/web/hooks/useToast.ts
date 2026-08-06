"use client";

import { useCallback } from "react";
import { useNotificationStore, DEFAULT_DURATIONS, type ToastVariant } from "@/lib/notifications";

export interface ToastOptions {
  variant: ToastVariant;
  title: string;
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
  details?: string;
}

export function useToast() {
  const addToast = useNotificationStore((s) => s.addToast);
  const dismissToast = useNotificationStore((s) => s.dismissToast);
  const dismissAllToasts = useNotificationStore((s) => s.dismissAllToasts);

  const toast = useCallback(
    (options: ToastOptions): string => {
      const duration = options.duration ?? DEFAULT_DURATIONS[options.variant];
      return addToast({ ...options, duration });
    },
    [addToast]
  );

  return { toast, dismiss: dismissToast, dismissAll: dismissAllToasts };
}
