import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";

export interface BugReportDraft {
  description?: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  actualBehavior?: string;
  environment?: string;
  nodeVersion?: string;
  modelProvider?: string;
  logs?: string;
}

interface BugReportContextValue {
  isOpen: boolean;
  draft: BugReportDraft | null;
  open: (draft?: BugReportDraft) => void;
  close: () => void;
}

const BugReportContext = createContext<BugReportContextValue | null>(null);

export function useOptionalBugReport(): BugReportContextValue | null {
  return useContext(BugReportContext);
}

export function useBugReport(): BugReportContextValue {
  const ctx = useOptionalBugReport();
  if (!ctx)
    throw new Error("useBugReport must be used within BugReportProvider");
  return ctx;
}

export function useBugReportState(): BugReportContextValue {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<BugReportDraft | null>(null);
  const open = useCallback((nextDraft?: BugReportDraft) => {
    setDraft(nextDraft ?? null);
    setIsOpen(true);
  }, []);
  const close = useCallback(() => {
    setIsOpen(false);
    setDraft(null);
  }, []);
  return { isOpen, draft, open, close };
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
