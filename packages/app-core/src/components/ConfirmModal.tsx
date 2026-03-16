/**
 * Branded confirmation modal to replace native window.confirm dialogs.
 *
 * Provides consistent styling, Escape-to-cancel keyboard handling,
 * and focus management.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ConfirmModalProps {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "warn" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

export interface PromptModalProps {
  open: boolean;
  title?: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

function canPortalToBody(): boolean {
  return (
    typeof document !== "undefined" &&
    !!document.body &&
    typeof document.body.appendChild === "function" &&
    !(globalThis as Record<string, unknown>).__TEST_RENDERER__
  );
}

function renderModalPortal(content: React.ReactNode) {
  if (canPortalToBody()) {
    return createPortal(content, document.body);
  }
  return content;
}

export function ConfirmModal({
  open,
  title = "Confirm",
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => confirmRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [onCancel],
  );

  if (!open) return null;

  const confirmBtnStyle: React.CSSProperties =
    tone === "danger"
      ? { background: "#ef4444", color: "#fff" }
      : tone === "warn"
        ? { background: "#f59e0b", color: "#fff" }
        : { background: "#f0b232", color: "#000" };

  const content = (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{
        zIndex: 10001,
        background: "color-mix(in srgb, var(--bg) 95%, transparent)",
        backdropFilter: "blur(24px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      <div
        className="rounded-xl max-w-md w-full mx-4 p-6"
        style={{
          background: "color-mix(in srgb, var(--bg) 96%, transparent)",
          border:
            "1px solid color-mix(in srgb, var(--accent) 18%, transparent)",
          backdropFilter: "blur(24px)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <h2
          className="text-base font-bold mb-3"
          style={{ color: "var(--text)" }}
        >
          {title}
        </h2>
        <p
          className="text-sm whitespace-pre-line mb-6"
          style={{ color: "var(--muted)" }}
        >
          {message}
        </p>
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-md transition-colors cursor-pointer"
            style={{
              border: "1px solid var(--border)",
              color: "var(--muted)",
              background: "transparent",
            }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-sm rounded-md transition-opacity font-medium cursor-pointer border-0"
            style={confirmBtnStyle}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  // Portal to body to escape any 3D transform stacking contexts (e.g. CompanionShell).
  // Skip portal in test environments where react-test-renderer can't handle real DOM portals.
  return renderModalPortal(content);
}

export function PromptModal({
  open,
  title = "Enter Value",
  message,
  placeholder,
  defaultValue = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: PromptModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [defaultValue, open]);

  const handleConfirm = useCallback(() => {
    onConfirm(value);
  }, [onConfirm, value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        handleConfirm();
      }
    },
    [handleConfirm, onCancel],
  );

  if (!open) return null;

  const content = (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{
        zIndex: 10001,
        background: "color-mix(in srgb, var(--bg) 95%, transparent)",
        backdropFilter: "blur(24px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      <div
        className="rounded-xl max-w-md w-full mx-4 p-6"
        style={{
          background: "color-mix(in srgb, var(--bg) 96%, transparent)",
          border:
            "1px solid color-mix(in srgb, var(--accent) 18%, transparent)",
          backdropFilter: "blur(24px)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <h2
          className="text-base font-bold mb-3"
          style={{ color: "var(--text)" }}
        >
          {title}
        </h2>
        <p
          className="text-sm whitespace-pre-line mb-4"
          style={{ color: "var(--muted)" }}
        >
          {message}
        </p>
        <input
          ref={inputRef}
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-md px-3 py-2 text-sm mb-6"
          style={{
            background: "var(--bg-hover)",
            color: "var(--text)",
            border: "1px solid var(--border)",
          }}
        />
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-md transition-colors cursor-pointer"
            style={{
              border: "1px solid var(--border)",
              color: "var(--muted)",
              background: "transparent",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-4 py-2 text-sm rounded-md transition-opacity font-medium cursor-pointer border-0"
            style={{ background: "#f0b232", color: "#000" }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return renderModalPortal(content);
}

/**
 * Hook providing an async confirm() that manages <ConfirmModal> state.
 *
 * Usage:
 *   const { confirm, modalProps } = useConfirm();
 *   const ok = await confirm({ message: "Delete?" });
 *   // render <ConfirmModal {...modalProps} /> somewhere in JSX
 */
export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "warn" | "default";
}

export function useConfirm() {
  const [state, setState] = useState<{
    opts: ConfirmOptions;
    resolve: (v: boolean) => void;
  } | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions): Promise<boolean> =>
      new Promise((resolve) => {
        setState({ opts, resolve });
      }),
    [],
  );

  const modalProps: ConfirmModalProps = state
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

export interface PromptOptions {
  title?: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function usePrompt() {
  const [state, setState] = useState<{
    opts: PromptOptions;
    resolve: (value: string | null) => void;
  } | null>(null);

  const prompt = useCallback(
    (opts: PromptOptions): Promise<string | null> =>
      new Promise((resolve) => {
        setState({ opts, resolve });
      }),
    [],
  );

  const modalProps: PromptModalProps = state
    ? {
        open: true,
        ...state.opts,
        onConfirm: (value) => {
          state.resolve(value);
          setState(null);
        },
        onCancel: () => {
          state.resolve(null);
          setState(null);
        },
      }
    : {
        open: false,
        message: "",
        onConfirm: () => {},
        onCancel: () => {},
      };

  return { prompt, modalProps };
}
