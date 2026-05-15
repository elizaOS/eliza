import type { BackgroundKind } from "./types";

export interface BackgroundEditPayload {
  id: string;
  sourceCode: string;
  kind: BackgroundKind;
  fpsBudget: number;
}

export interface BackgroundEditAction {
  type: "BACKGROUND_EDIT";
  payload: BackgroundEditPayload;
}

export const BACKGROUND_EDIT_ACTION_TYPE = "BACKGROUND_EDIT" as const;

// TODO: sandbox — dynamic loader for BACKGROUND_EDIT actions will live here.
// The loader needs to compile sourceCode in a sandboxed context, validate it
// against the BackgroundModule contract, benchmark fpsBudget, and register the
// module via registerBackground. No runtime execution path exists in this pass.
export function applyBackgroundEdit(
  _action: BackgroundEditAction,
): never | undefined {
  throw new Error("applyBackgroundEdit: sandbox loader not implemented");
}
