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
export type ModalState =
  | {
      status: "closed";
    }
  | {
      status: "open";
    }
  | {
      status: "submitting";
    }
  | {
      status: "error";
      error: Error;
    };
export interface ModalApi {
  state: ModalState;
  open: () => void;
  close: () => void;
  submit: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
}
export declare function useModalState(): ModalApi;
//# sourceMappingURL=useModalState.d.ts.map
