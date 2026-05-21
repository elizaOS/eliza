/**
 * Container logs viewer component displaying container logs with streaming support.
 * Supports log filtering, search, download, auto-refresh, and streaming mode.
 *
 * @param props - Container logs viewer configuration
 * @param props.containerId - Container ID to fetch logs for
 * @param props.containerName - Container name for display
 */

"use client";

import {
  BrandButton,
  LogViewer,
  type LogViewerStructuredEntry,
} from "@elizaos/ui";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { ParsedLogEntry } from "@/lib/types/containers";

// Alias for component usage
type LogEntry = ParsedLogEntry;

interface ContainerLogsViewerProps {
  containerId: string;
  containerName: string;
}

interface LogsState {
  logs: LogEntry[];
  loading: boolean;
  error: string | null;
  infoMessage: string | null;
}

interface StreamingState {
  autoRefresh: boolean;
  useStreaming: boolean;
  isStreaming: boolean;
}

interface FilterState {
  level: string;
  searchQuery: string;
}

function mergeState<TState extends object>(
  previous: TState,
  updates: Partial<TState>,
): TState {
  const entries = Object.entries(updates) as Array<
    [keyof TState, TState[keyof TState]]
  >;
  if (entries.every(([key, value]) => Object.is(previous[key], value))) {
    return previous;
  }
  return { ...previous, ...updates };
}

type BadgeVariant = "default" | "destructive" | "outline" | "secondary";

function formatLogLine(log: LogEntry): string {
  const timestamp = new Date(log.timestamp).toISOString();
  const metadata = log.metadata ? ` | ${JSON.stringify(log.metadata)}` : "";
  return `[${timestamp}] [${log.level.toUpperCase()}] ${log.message}${metadata}`;
}

function getLevelColor(logLevel: string): string {
  switch (logLevel) {
    case "error":
      return "text-red-500";
    case "warn":
      return "text-yellow-500";
    case "info":
      return "text-white/70";
    case "debug":
      return "text-gray-500";
    default:
      return "text-foreground";
  }
}

function getLevelBadgeVariant(logLevel: string): BadgeVariant {
  switch (logLevel) {
    case "error":
      return "destructive";
    case "info":
      return "default";
    case "debug":
      return "secondary";
    default:
      return "outline";
  }
}

function getLevelBorderColor(logLevel: string): string {
  switch (logLevel) {
    case "error":
      return "#ef4444";
    case "warn":
      return "#eab308";
    case "info":
      return "#3b82f6";
    default:
      return "#6b7280";
  }
}

export function ContainerLogsViewer({
  containerId,
  containerName,
}: ContainerLogsViewerProps) {
  const [logsState, setLogsState] = useState<LogsState>({
    logs: [],
    loading: true,
    error: null,
    infoMessage: null,
  });

  const [streamingState, setStreamingState] = useState<StreamingState>({
    autoRefresh: false,
    useStreaming: true,
    isStreaming: false,
  });

  const [filterState, setFilterState] = useState<FilterState>({
    level: "all",
    searchQuery: "",
  });

  const updateLogs = useCallback((updates: Partial<LogsState>) => {
    setLogsState((prev) => mergeState(prev, updates));
  }, []);

  const updateStreaming = useCallback((updates: Partial<StreamingState>) => {
    setStreamingState((prev) => mergeState(prev, updates));
  }, []);

  const updateFilter = useCallback((updates: Partial<FilterState>) => {
    setFilterState((prev) => mergeState(prev, updates));
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const fetchLogs = useCallback(async () => {
    updateLogs({ loading: true, error: null });
    const params = new URLSearchParams({
      limit: "100",
      ...(filterState.level !== "all" && { level: filterState.level }),
    });

    try {
      const response = await fetch(
        `/api/v1/containers/${containerId}/logs?${params}`,
      );

      if (!response.ok) {
        throw new Error("Failed to fetch logs");
      }

      const data = await response.json();
      if (data.success) {
        updateLogs({
          logs: data.data.logs || [],
          infoMessage: data.data.message || null,
          error: null,
          loading: false,
        });
      } else {
        updateLogs({
          error: data.error || "Failed to load logs",
          infoMessage: null,
          loading: false,
        });
      }
    } catch (err) {
      updateLogs({
        error: err instanceof Error ? err.message : "Failed to fetch logs",
        infoMessage: null,
        loading: false,
      });
    }
  }, [containerId, filterState.level, updateLogs]);

  const startStreaming = useCallback(() => {
    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const params = new URLSearchParams({
      ...(filterState.level !== "all" && { level: filterState.level }),
    });

    const eventSource = new EventSource(
      `/api/v1/containers/${containerId}/logs/stream?${params}`,
    );

    eventSource.onopen = () => {
      updateStreaming({ isStreaming: true });
      updateLogs({ error: null });
    };

    eventSource.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);

        if (parsed.type === "log") {
          setLogsState((prev) => {
            const newLog = parsed.data;
            // Check if log already exists
            const exists = prev.logs.some(
              (log) =>
                log.timestamp === newLog.timestamp &&
                log.message === newLog.message,
            );
            if (exists) return prev;

            // Add new log and keep only last 500 logs
            const updated = [newLog, ...prev.logs];
            return { ...prev, logs: updated.slice(0, 500) };
          });
        } else if (parsed.type === "error") {
          updateLogs({ error: parsed.message });
        }
      } catch {
        // Malformed SSE frame — ignore and wait for the next event.
      }
    };

    eventSource.onerror = () => {
      updateStreaming({ isStreaming: false });
      eventSource.close();
      // Fallback to polling when the SSE connection drops.
      if (streamingState.useStreaming) {
        updateStreaming({ useStreaming: false, autoRefresh: true });
      }
    };

    eventSourceRef.current = eventSource;
  }, [
    containerId,
    filterState.level,
    streamingState.useStreaming,
    updateLogs,
    updateStreaming,
  ]);

  const closeStreamingConnection = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const stopStreaming = useCallback(() => {
    closeStreamingConnection();
    updateStreaming({ isStreaming: false });
  }, [closeStreamingConnection, updateStreaming]);

  // Initial load
  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  // Handle streaming vs polling
  useEffect(() => {
    if (streamingState.autoRefresh && streamingState.useStreaming) {
      // Start streaming
      startStreaming();
      return () => stopStreaming();
    } else if (streamingState.autoRefresh && !streamingState.useStreaming) {
      // Fallback to polling
      const interval = setInterval(fetchLogs, 5000);
      return () => clearInterval(interval);
    } else {
      stopStreaming();
    }
  }, [
    streamingState.autoRefresh,
    streamingState.useStreaming,
    startStreaming,
    stopStreaming,
    fetchLogs,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      closeStreamingConnection();
    };
  }, [closeStreamingConnection]);

  const downloadLogs = () => {
    const logsText = logsState.logs.map(formatLogLine).join("\n");

    const blob = new Blob([logsText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${containerName}-logs-${new Date().toISOString()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyAllLogs = async () => {
    const logsText = logsState.logs.map(formatLogLine).join("\n");

    await navigator.clipboard.writeText(logsText);
    toast.success("Logs copied to clipboard");
  };

  const copyLogLine = async (log: LogEntry) => {
    await navigator.clipboard.writeText(formatLogLine(log));
    toast.success("Log line copied");
  };

  const filteredLogs = useMemo(
    () =>
      logsState.logs.filter((log) => {
        if (!filterState.searchQuery) return true;
        const searchLower = filterState.searchQuery.toLowerCase();
        return (
          log.message.toLowerCase().includes(searchLower) ||
          log.level.toLowerCase().includes(searchLower) ||
          (log.metadata &&
            JSON.stringify(log.metadata).toLowerCase().includes(searchLower))
        );
      }),
    [filterState.searchQuery, logsState.logs],
  );

  const filteredEntries = useMemo<LogViewerStructuredEntry[]>(
    () =>
      filteredLogs.map((log, index) => ({
        id: `${log.timestamp}-${index}`,
        timestamp: log.timestamp,
        level: log.level,
        message: log.message,
        metadata: log.metadata,
      })),
    [filteredLogs],
  );

  return (
    <LogViewer
      title="Container Logs"
      subtitle={`Real-time logs from ${containerName}`}
      search={{
        value: filterState.searchQuery,
        onChange: (searchQuery) => updateFilter({ searchQuery }),
        placeholder: "Search logs...",
        resultLabel:
          (filterState.searchQuery || filterState.level !== "all") &&
          filteredLogs.length < logsState.logs.length
            ? `Showing ${filteredLogs.length} of ${logsState.logs.length} logs`
            : null,
      }}
      levelFilter={{
        value: filterState.level,
        onChange: (level) => updateFilter({ level }),
        options: [
          { value: "all", label: "All Levels" },
          { value: "error", label: "Errors" },
          { value: "warn", label: "Warnings" },
          { value: "info", label: "Info" },
          { value: "debug", label: "Debug" },
        ],
      }}
      loading={logsState.loading}
      error={logsState.error}
      errorTitle={
        logsState.error?.includes("not been deployed")
          ? "Container Not Yet Deployed"
          : logsState.error?.includes("not found")
            ? "Container Logs Not Found"
            : "Error Loading Logs"
      }
      showRetryOnError={!logsState.error?.includes("not been deployed")}
      onRetry={fetchLogs}
      emptyState={{
        title: logsState.infoMessage || "No logs available for this container",
        description: logsState.infoMessage
          ? undefined
          : "Logs may take a few moments to appear after deployment",
        action: (
          <BrandButton variant="outline" size="sm" onClick={fetchLogs}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </BrandButton>
        ),
      }}
      filteredEmptyState={{
        title: "No logs match your search criteria",
        action: (
          <BrandButton
            variant="outline"
            size="sm"
            onClick={() => updateFilter({ searchQuery: "", level: "all" })}
          >
            Clear Filters
          </BrandButton>
        ),
      }}
      isFilteredEmpty={
        logsState.logs.length > 0 && filteredEntries.length === 0
      }
      entries={filteredEntries}
      onCopyEntry={(entry) => {
        const log = filteredLogs.find(
          (candidate) =>
            candidate.timestamp === entry.timestamp &&
            candidate.message === entry.message,
        );
        if (log) void copyLogLine(log);
      }}
      entryClassName={(entry) => getLevelColor(entry.level ?? "")}
      entryLevelVariant={(level) => getLevelBadgeVariant(level)}
      entryLevelBorderColor={(level) => getLevelBorderColor(level)}
      contentRef={scrollRef}
      heightClassName="h-[400px]"
      onToggleStreaming={() =>
        updateStreaming({ autoRefresh: !streamingState.autoRefresh })
      }
      streamingTitle={
        streamingState.autoRefresh
          ? streamingState.isStreaming
            ? "Streaming (click to stop)"
            : "Polling (click to stop)"
          : "Start auto-refresh"
      }
      streaming={{
        enabled: streamingState.autoRefresh || streamingState.isStreaming,
        active: streamingState.isStreaming,
        activeLabel: "Live streaming enabled",
        inactiveLabel: "Auto-refreshing every 5 seconds",
      }}
      onCopyAll={copyAllLogs}
      onDownload={downloadLogs}
      copyDisabled={logsState.logs.length === 0}
      downloadDisabled={logsState.logs.length === 0}
    />
  );
}
