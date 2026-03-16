import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";

interface BugReportContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const BugReportContext = createContext<BugReportContextValue | null>(null);

export function useBugReport(): BugReportContextValue {
  const ctx = useContext(BugReportContext);
  if (!ctx)
    throw new Error("useBugReport must be used within BugReportProvider");
  return ctx;
}

export function useBugReportState(): BugReportContextValue {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  return { isOpen, open, close };
}

export function BugReportProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: BugReportContextValue;
}) {
  return (
    <BugReportContext.Provider value={value}>
      {children}
    </BugReportContext.Provider>
  );
}
