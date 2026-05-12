/**
 * useModalState — canonical state machine for modal dialogs.
 *
 * Replaces the common (isOpen, isSubmitting, error) triple-useState pattern
 * with a single tagged union. The state machine has four states:
 *
 *   closed → open → submitting → closed | error → open | closed
 *
 * `submit(fn)` runs a side-effectful submission. On success the modal closes
 * and the result is returned. On error the modal moves to `error` state and
 * the call returns `undefined`. `close()` clears any error regardless of
 * the current state.
 */

import { useCallback, useState } from "react";

export type ModalState =
  | { status: "closed" }
  | { status: "open" }
  | { status: "submitting" }
  | { status: "error"; error: Error };

export interface ModalApi {
  state: ModalState;
  open: () => void;
  close: () => void;
  submit: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  return new Error(
    typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value),
  );
}

export function useModalState(): ModalApi {
  const [state, setState] = useState<ModalState>({ status: "closed" });

  const open = useCallback(() => {
    setState({ status: "open" });
  }, []);

  const close = useCallback(() => {
    setState({ status: "closed" });
  }, []);

  const submit = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      setState({ status: "submitting" });
      try {
        const result = await fn();
        setState({ status: "closed" });
        return result;
      } catch (err: unknown) {
        setState({ status: "error", error: toError(err) });
        return undefined;
      }
    },
    [],
  );

  return { state, open, close, submit };
}
