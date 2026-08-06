"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  X,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToastItem } from "@/lib/notifications";

interface ToastProps {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}

const VARIANT_CONFIG = {
  success: {
    border: "border-green-800",
    bg: "bg-green-950/90",
    icon: CheckCircle2,
    iconColor: "text-green-400",
    progress: "bg-green-500",
  },
  error: {
    border: "border-red-800",
    bg: "bg-red-950/90",
    icon: XCircle,
    iconColor: "text-red-400",
    progress: "bg-red-500",
  },
  warning: {
    border: "border-yellow-800",
    bg: "bg-yellow-950/90",
    icon: AlertTriangle,
    iconColor: "text-yellow-400",
    progress: "bg-yellow-500",
  },
  info: {
    border: "border-blue-800",
    bg: "bg-blue-950/90",
    icon: Info,
    iconColor: "text-blue-400",
    progress: "bg-blue-500",
  },
  loading: {
    border: "border-surface-700",
    bg: "bg-surface-800",
    icon: Loader2,
    iconColor: "text-brand-400",
    progress: "bg-brand-500",
  },
} as const;

export function Toast({ toast, onDismiss }: ToastProps) {
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [progress, setProgress] = useState(100);

  // Track remaining time across pause/resume cycles
  const remainingRef = useRef(toast.duration);

  const dismiss = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);

  useEffect(() => {
    if (toast.duration === 0) return; // loading: never auto-dismiss
    if (paused) return;

    const snapRemaining = remainingRef.current;
    const start = Date.now();

    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const newRemaining = Math.max(0, snapRemaining - elapsed);
      remainingRef.current = newRemaining;
      setProgress((newRemaining / toast.duration) * 100);

      if (newRemaining === 0) {
        clearInterval(interval);
        dismiss();
      }
    }, 50);

    return () => clearInterval(interval);
  }, [paused, toast.duration, dismiss]);

  const config = VARIANT_CONFIG[toast.variant];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-lg shadow-xl border overflow-hidden",
        "w-80 pointer-events-auto backdrop-blur-sm",
        config.border,
        config.bg
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="flex items-start gap-3 p-3.5 pb-5">
        {/* Icon */}
        <div className={cn("mt-0.5 shrink-0", config.iconColor)}>
          <Icon
            className={cn("w-4 h-4", toast.variant === "loading" && "animate-spin")}
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-surface-100 leading-snug">
            {toast.title}
          </p>
          {toast.description && (
            <p className="text-xs text-surface-400 mt-0.5 leading-relaxed">
              {toast.description}
            </p>
          )}

          {/* Action button */}
          {toast.action && (
            <button
              onClick={() => {
                toast.action!.onClick();
                dismiss();
              }}
              className="mt-2 text-xs font-medium text-brand-400 hover:text-brand-300 transition-colors"
            >
              {toast.action.label}
            </button>
          )}

          {/* Expandable details */}
          {toast.details && (
            <div className="mt-1.5">
              <button
                onClick={() => setExpanded((e) => !e)}
                className="flex items-center gap-1 text-xs text-surface-500 hover:text-surface-300 transition-colors"
              >
                <ChevronDown
                  className={cn(
                    "w-3 h-3 transition-transform duration-150",
                    expanded && "rotate-180"
                  )}
                />
                {expanded ? "Hide details" : "Show details"}
              </button>
              {expanded && (
                <pre className="mt-1.5 text-xs text-surface-400 bg-surface-900/80 rounded p-2 overflow-auto max-h-24 font-mono whitespace-pre-wrap break-all">
                  {toast.details}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* Dismiss button */}
        <button
          onClick={dismiss}
          className="shrink-0 text-surface-600 hover:text-surface-200 transition-colors"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Progress bar */}
      {toast.duration > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-surface-700/50">
          <div
            className={cn("h-full transition-none", config.progress)}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}
