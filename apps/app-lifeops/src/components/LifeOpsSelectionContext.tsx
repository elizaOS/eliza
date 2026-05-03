import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export interface LifeOpsSelection {
  eventId: string | null;
  messageId: string | null;
  reminderId: string | null;
}

interface SelectArgs {
  eventId?: string | null;
  messageId?: string | null;
  reminderId?: string | null;
}

interface LifeOpsSelectionContextValue {
  selection: LifeOpsSelection;
  select: (args: SelectArgs) => void;
  clearSelection: () => void;
}

const EMPTY_SELECTION: LifeOpsSelection = {
  eventId: null,
  messageId: null,
  reminderId: null,
};

const LifeOpsSelectionContext =
  createContext<LifeOpsSelectionContextValue | null>(null);

export function LifeOpsSelectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [selection, setSelection] = useState<LifeOpsSelection>(EMPTY_SELECTION);

  const select = useCallback((args: SelectArgs) => {
    setSelection({
      eventId: args.eventId ?? null,
      messageId: args.messageId ?? null,
      reminderId: args.reminderId ?? null,
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(EMPTY_SELECTION);
  }, []);

  const value = useMemo(
    () => ({ selection, select, clearSelection }),
    [selection, select, clearSelection],
  );

  return (
    <LifeOpsSelectionContext.Provider value={value}>
      {children}
    </LifeOpsSelectionContext.Provider>
  );
}

export function useLifeOpsSelection(): LifeOpsSelectionContextValue {
  const ctx = useContext(LifeOpsSelectionContext);
  if (!ctx) {
    throw new Error(
      "useLifeOpsSelection must be used inside LifeOpsSelectionProvider",
    );
  }
  return ctx;
}
