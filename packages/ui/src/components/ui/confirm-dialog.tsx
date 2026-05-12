import * as React from "react";

import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Field, FieldLabel } from "./field";
import { Input } from "./input";

export type ConfirmVariant = "danger" | "warn" | "default";

export interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title = "Confirm",
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant: variantProp,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const variant = variantProp ?? "default";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen: boolean) => {
        if (!nextOpen) onCancel();
      }}
    >
      <DialogContent className="max-w-md rounded-2xl border-border/60 bg-bg shadow-[var(--shadow-lg)] backdrop-blur-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line text-muted-strong">
            {message}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            className={
              variant === "danger"
                ? "border-destructive/70 bg-destructive text-destructive-fg hover:border-destructive hover:bg-destructive"
                : variant === "warn"
                  ? "border-warn/55 bg-warn/92 !text-black hover:border-warn hover:bg-warn"
                  : "border-accent/55 bg-accent/22 text-accent-fg hover:border-accent/75 hover:bg-accent/32"
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface PromptDialogProps {
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

export function PromptDialog({
  open,
  title = "Enter Value",
  message,
  placeholder,
  defaultValue = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const inputId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [value, setValue] = React.useState(defaultValue);

  React.useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [defaultValue, open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen: boolean) => {
        if (!nextOpen) onCancel();
      }}
    >
      <DialogContent className="max-w-md rounded-2xl border-border/60 bg-bg shadow-[var(--shadow-lg)] backdrop-blur-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line text-muted-strong">
            {message}
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={inputId}>Value</FieldLabel>
          <Input
            id={inputId}
            ref={inputRef}
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onConfirm(value);
              }
            }}
          />
        </Field>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button onClick={() => onConfirm(value)}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
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

export interface PromptOptions {
  title?: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
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
