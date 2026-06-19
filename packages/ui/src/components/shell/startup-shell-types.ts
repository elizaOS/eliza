import type { ReactNode } from "react";
import type { StartupErrorState } from "../../state/types";

export type StartupShellView =
  | { kind: "error"; error: StartupErrorState }
  | { kind: "pairing" }
  | { kind: "bootstrap"; onAdvance: () => void }
  | { kind: "first-run" }
  | { kind: "loading"; phase: string; status: string }
  | { kind: "none" };

export interface StartupShellProps {
  view: StartupShellView;
  firstRun: ReactNode;
  onRetry: () => void;
}
