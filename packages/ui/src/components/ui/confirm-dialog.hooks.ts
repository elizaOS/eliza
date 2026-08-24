/**
 * Imperative `useConfirm` / `usePrompt` hooks that turn the controlled
 * ConfirmDialog / PromptDialog into promise-returning calls: `confirm(opts)` /
 * `prompt(opts)` resolve when the user chooses, and the returned `modalProps`
 * is spread onto the matching dialog component (`confirm-dialog.tsx`).
 */
import * as React from "react";

import type {
  ConfirmDialogProps,
  ConfirmOptions,
  PromptDialogProps,
  PromptOptions,
} from "./confirm-dialog";

export function useConfirm() {
  type PendingConfirm = {
    opts: ConfirmOptions;
    resolve: (v: boolean) => void;
  };
  const [state, setState] = React.useState<PendingConfirm | null>(null);
  const pendingRef = React.useRef<PendingConfirm | null>(null);

  const settle = React.useCallback(
    (pending: PendingConfirm, value: boolean) => {
      if (pendingRef.current !== pending) return;
      pendingRef.current = null;
      pending.resolve(value);
      setState((current) => (current === pending ? null : current));
    },
    [],
  );

  const confirm = React.useCallback(
    (opts: ConfirmOptions): Promise<boolean> =>
      new Promise((resolve) => {
        const superseded = pendingRef.current;
        if (superseded) {
          pendingRef.current = null;
          superseded.resolve(false);
        }

        const pending = { opts, resolve };
        pendingRef.current = pending;
        setState(pending);
      }),
    [],
  );

  React.useEffect(
    () => () => {
      const pending = pendingRef.current;
      if (!pending) return;
      pendingRef.current = null;
      pending.resolve(false);
    },
    [],
  );

  const modalProps: ConfirmDialogProps = state
    ? {
        open: true,
        ...state.opts,
        onConfirm: () => {
          settle(state, true);
        },
        onCancel: () => {
          settle(state, false);
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

export function usePrompt() {
  type PendingPrompt = {
    opts: PromptOptions;
    resolve: (value: string | null) => void;
  };
  const [state, setState] = React.useState<PendingPrompt | null>(null);
  const pendingRef = React.useRef<PendingPrompt | null>(null);

  const settle = React.useCallback(
    (pending: PendingPrompt, value: string | null) => {
      if (pendingRef.current !== pending) return;
      pendingRef.current = null;
      pending.resolve(value);
      setState((current) => (current === pending ? null : current));
    },
    [],
  );

  const prompt = React.useCallback(
    (opts: PromptOptions): Promise<string | null> =>
      new Promise((resolve) => {
        const superseded = pendingRef.current;
        if (superseded) {
          pendingRef.current = null;
          superseded.resolve(null);
        }

        const pending = { opts, resolve };
        pendingRef.current = pending;
        setState(pending);
      }),
    [],
  );

  React.useEffect(
    () => () => {
      const pending = pendingRef.current;
      if (!pending) return;
      pendingRef.current = null;
      pending.resolve(null);
    },
    [],
  );

  const modalProps: PromptDialogProps = state
    ? {
        open: true,
        ...state.opts,
        onConfirm: (value) => {
          settle(state, value);
        },
        onCancel: () => {
          settle(state, null);
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
