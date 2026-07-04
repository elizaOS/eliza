/** Shared view/prop types for the startup shell (StartupScreen ↔ StartupShell). */

import type { StartupErrorState } from "../../state/types";

export type StartupShellView =
  | { kind: "error"; error: StartupErrorState }
  | { kind: "pairing" }
  | { kind: "bootstrap"; onAdvance: () => void }
  | { kind: "loading"; phase: string; status: string }
  | { kind: "none" };

export interface StartupShellProps {
  view: StartupShellView;
  onRetry: () => void;
}
