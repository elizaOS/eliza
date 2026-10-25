/**
 * Provider that supplies the bug-report draft context to the shell so any
 * surface can open the report form pre-populated.
 */
import type { ReactNode } from "react";
import {
  BugReportContext,
  type BugReportContextValue,
} from "./useBugReport.hooks";

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
