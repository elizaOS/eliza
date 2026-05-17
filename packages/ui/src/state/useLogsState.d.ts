/**
 * Logs state — extracted from AppContext.
 *
 * Manages log entries, sources, tags, and filter state.
 * The loadLogs callback reads all three filter values from state.
 */
import type { LogEntry } from "../api";
export declare function useLogsState(): {
  state: {
    logs: LogEntry[];
    logSources: string[];
    logTags: string[];
    logTagFilter: string;
    logLevelFilter: string;
    logSourceFilter: string;
    logLoadError: string | null;
  };
  setLogs: import("react").Dispatch<import("react").SetStateAction<LogEntry[]>>;
  setLogTagFilter: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setLogLevelFilter: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setLogSourceFilter: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  loadLogs: () => Promise<void>;
};
//# sourceMappingURL=useLogsState.d.ts.map
