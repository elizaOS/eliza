// LifeOps selection React context + hook, split out of
// LifeOpsSelectionContext.tsx so that file exports only the provider component
// and stays Fast-Refresh-compatible (Vite full-reloads a component file that
// also exports a hook / context / types). The provider lives in the .tsx and
// imports the context object from here.

import { createContext, useContext } from "react";

export interface LifeOpsSelection {
  eventId: string | null;
  messageId: string | null;
  reminderId: string | null;
}

export interface SelectArgs {
  eventId?: string | null;
  messageId?: string | null;
  reminderId?: string | null;
}

export interface LifeOpsSelectionContextValue {
  selection: LifeOpsSelection;
  select: (args: SelectArgs) => void;
  clearSelection: () => void;
}

export const EMPTY_SELECTION: LifeOpsSelection = {
  eventId: null,
  messageId: null,
  reminderId: null,
};

export const LifeOpsSelectionContext =
  createContext<LifeOpsSelectionContextValue | null>(null);

export function useLifeOpsSelection(): LifeOpsSelectionContextValue {
  const ctx = useContext(LifeOpsSelectionContext);
  if (!ctx) {
    throw new Error(
      "useLifeOpsSelection must be used inside LifeOpsSelectionProvider",
    );
  }
  return ctx;
}
