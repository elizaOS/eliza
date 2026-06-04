import * as React from "react";

import type {
  ConfirmDialogProps,
  ConfirmOptions,
  PromptDialogProps,
  PromptOptions,
} from "./confirm-dialog";

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

export function usePrompt() {
  const [state, setState] = React.useState<{
    opts: PromptOptions;
    resolve: (value: string | null) => void;
  } | null>(null);

  const prompt = React.useCallback(
    (opts: PromptOptions): Promise<string | null> =>
      new Promise((resolve) => {
        setState({ opts, resolve });
      }),
    [],
  );

  const modalProps: PromptDialogProps = state
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
