import { useCallback, useMemo, useState } from "react";
import {
  EMPTY_SELECTION,
  type LifeOpsSelection,
  LifeOpsSelectionContext,
  type SelectArgs,
} from "./LifeOpsSelectionContext.helpers.js";

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
