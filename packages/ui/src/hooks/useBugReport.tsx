/**
 * Compatibility re-export. The bug-report context object, hooks, and types live
 * in `./useBugReport.hooks`; the `BugReportProvider` component lives in
 * `./BugReportProvider` — each split so they stay React Fast Refresh-compatible.
 * This barrel keeps the `hooks` + `browser` facades resolving unchanged.
 */
export { BugReportProvider } from "./BugReportProvider";
export {
  BugReportContext,
  type BugReportContextValue,
  type BugReportDraft,
  useBugReport,
  useBugReportState,
  useOptionalBugReport,
} from "./useBugReport.hooks";
