import * as React from "react";
import { cn } from "../../lib/utils";

/* ── ConfirmDialog ───────────────────────────────────────────────────── */

export type ConfirmTone = "danger" | "warn" | "default";

export interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  onConfirm: () => void;
  onCancel: () => void;
}

const TONE_STYLES: Record<ConfirmTone, string> = {
  danger: "bg-destructive text-destructive-fg hover:opacity-90",
  warn: "bg-warn text-white hover:opacity-90",
  default: "bg-primary text-primary-fg hover:opacity-90",
};

export function ConfirmDialog({
  open,
  title = "Confirm",
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (open) {
      const t = setTimeout(() => confirmRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [onCancel],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/40"
      style={{ zIndex: 10001 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      <div className="mx-4 w-full max-w-md rounded-lg border border-border bg-bg p-6 shadow-2xl">
        <h2 className="mb-3 text-base font-bold">{title}</h2>
        <p className="mb-6 whitespace-pre-line text-sm text-muted">{message}</p>
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-4 py-2 text-sm transition-colors hover:bg-bg-hover"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={cn(
              "rounded-md px-4 py-2 text-sm font-medium transition-opacity",
              TONE_STYLES[tone],
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── useConfirm hook ─────────────────────────────────────────────────── */

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

export function useConfirm() {
  const [state, setState] = React.useState<{
    opts: ConfirmOptions;
    resolve: (v: boolean) => void;
  } | null>(null);

  const confirm = React.useCallback(
    (opts: ConfirmOptions): Promise<boolean> =>
      new Promise((resolve) => {
        setState({ opts, resolve });
      }),
    [],
  );

  const modalProps: ConfirmDialogProps = state
    ? {
        open: true,
        ...state.opts,
        onConfirm: () => {
          state.resolve(true);
          setState(null);
        },
        onCancel: () => {
          state.resolve(false);
          setState(null);
        },
      }
    : {
        open: false,
        message: "",
        onConfirm: () => {},
        onCancel: () => {},
      };

  return { confirm, modalProps };
}
