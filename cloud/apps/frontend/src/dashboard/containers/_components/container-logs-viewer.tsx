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
  Badge,
  BrandButton,
  BrandCard,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "@elizaos/cloud-ui";
import { Copy, Download, RefreshCw, Search, Wifi, WifiOff } from "lucide-react";
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

function mergeState<TState extends object>(previous: TState, updates: Partial<TState>): TState {
  const entries = Object.entries(updates) as Array<[keyof TState, TState[keyof TState]]>;
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
      return "text-blue-500";
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
    case "warn":
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

export function ContainerLogsViewer({ containerId, containerName }: ContainerLogsViewerProps) {
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
      const response = await fetch(`/api/v1/containers/${containerId}/logs?${params}`);

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

    const eventSource = new EventSource(`/api/v1/containers/${containerId}/logs/stream?${params}`);

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
              (log) => log.timestamp === newLog.timestamp && log.message === newLog.message,
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
  }, [containerId, filterState.level, streamingState.useStreaming, updateLogs, updateStreaming]);

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
          (log.metadata && JSON.stringify(log.metadata).toLowerCase().includes(searchLower))
        );
      }),
    [filterState.searchQuery, logsState.logs],
  );

  return (
    <BrandCard className="relative shadow-lg shadow-black/50" cornerSize="sm">
      <div className="relative z-10 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-block w-2 h-2 rounded-full bg-[#FF5800]" />
              <h2
                className="text-xl font-normal text-white"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                Container Logs
              </h2>
            </div>
            <p className="text-sm text-white/60">Real-time logs from {containerName}</p>
          </div>
          <div className="flex items-center gap-2">
            <BrandButton
              variant="outline"
              size="sm"
              onClick={() => updateStreaming({ autoRefresh: !streamingState.autoRefresh })}
              title={
                streamingState.autoRefresh
                  ? streamingState.isStreaming
                    ? "Streaming (click to stop)"
                    : "Polling (click to stop)"
                  : "Start auto-refresh"
              }
            >
              {streamingState.isStreaming ? (
                <Wifi className="h-4 w-4" />
              ) : streamingState.autoRefresh ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <WifiOff className="h-4 w-4" />
              )}
            </BrandButton>
            <BrandButton
              variant="outline"
              size="sm"
              onClick={copyAllLogs}
              disabled={logsState.logs.length === 0}
              title="Copy all logs"
            >
              <Copy className="h-4 w-4" />
            </BrandButton>
            <BrandButton
              variant="outline"
              size="sm"
              onClick={downloadLogs}
              disabled={logsState.logs.length === 0}
              title="Download logs"
            >
              <Download className="h-4 w-4" />
            </BrandButton>
          </div>
        </div>

        {/* Search and Filter Bar */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/60" />
            <Input
              placeholder="Search logs..."
              value={filterState.searchQuery}
              onChange={(e) => updateFilter({ searchQuery: e.target.value })}
              className="pl-9 rounded-none border-white/10 bg-black/40 text-white placeholder:text-white/40 focus-visible:ring-[#FF5800]/50"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            />
          </div>
          <Select value={filterState.level} onValueChange={(v) => updateFilter({ level: v })}>
            <SelectTrigger
              className="w-full sm:w-[140px] rounded-none border-white/10 bg-black/40"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-none border-white/10 bg-[#0A0A0A]">
              <SelectItem value="all">All Levels</SelectItem>
              <SelectItem value="error">Errors</SelectItem>
              <SelectItem value="warn">Warnings</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {(filterState.searchQuery || filterState.level !== "all") &&
          filteredLogs.length < logsState.logs.length && (
            <div
              className="text-sm text-white/60 mt-2"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              Showing {filteredLogs.length} of {logsState.logs.length} logs
            </div>
          )}

        <div>
          {logsState.loading && logsState.logs.length === 0 ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full rounded-none" />
              <Skeleton className="h-8 w-full rounded-none" />
              <Skeleton className="h-8 w-full rounded-none" />
            </div>
          ) : logsState.error ? (
            <div className="text-center py-8">
              <div className="mb-4">
                <p
                  className="text-red-400 font-medium mb-2"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {logsState.error.includes("not been deployed")
                    ? "Container Not Yet Deployed"
                    : logsState.error.includes("not found")
                      ? "Container Logs Not Found"
                      : "Error Loading Logs"}
                </p>
                <p className="text-sm text-white/60">{logsState.error}</p>
              </div>
              {!logsState.error.includes("not been deployed") && (
                <BrandButton variant="outline" size="sm" onClick={fetchLogs} className="mt-4">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Retry
                </BrandButton>
              )}
            </div>
          ) : logsState.logs.length === 0 ? (
            <div className="text-center py-8">
              <div className="space-y-2">
                <p className="text-white/60">
                  {logsState.infoMessage || "No logs available for this container"}
                </p>
                {!logsState.infoMessage && (
                  <p className="text-xs text-white/50">
                    Logs may take a few moments to appear after deployment
                  </p>
                )}
                <BrandButton variant="outline" size="sm" onClick={fetchLogs} className="mt-4">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Refresh
                </BrandButton>
              </div>
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-white/60">No logs match your search criteria</p>
              <BrandButton
                variant="outline"
                size="sm"
                onClick={() => {
                  updateFilter({ searchQuery: "", level: "all" });
                }}
                className="mt-4"
              >
                Clear Filters
              </BrandButton>
            </div>
          ) : (
            <ScrollArea
              className="h-[400px] w-full rounded-none border border-white/10"
              ref={scrollRef}
            >
              <div
                className="p-4 font-mono text-sm space-y-1"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {filteredLogs.map((log, index) => (
                  <div
                    key={`${log.timestamp}-${index}`}
                    className={`group flex gap-3 p-2 hover:bg-white/5 rounded-none transition-colors border-l-2 ${getLevelColor(log.level)}`}
                    style={{ borderLeftColor: getLevelBorderColor(log.level) }}
                  >
                    <Badge
                      variant={getLevelBadgeVariant(log.level)}
                      className="shrink-0 h-5 text-xs rounded-none font-mono"
                    >
                      {log.level.toUpperCase()}
                    </Badge>
                    <span className="text-xs text-white/60 shrink-0 min-w-[70px]">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="flex-1 break-all whitespace-pre-wrap text-white/80">
                      {log.message}
                    </span>
                    {log.metadata && Object.keys(log.metadata).length > 0 && (
                      <span className="text-xs text-white/50 max-w-[200px] truncate">
                        {JSON.stringify(log.metadata)}
                      </span>
                    )}
                    <BrandButton
                      variant="ghost"
                      size="sm"
                      onClick={() => copyLogLine(log)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 p-0 shrink-0"
                      title="Copy log line"
                    >
                      <Copy className="h-3 w-3" />
                    </BrandButton>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
          {(streamingState.autoRefresh || streamingState.isStreaming) && (
            <div
              className="flex items-center justify-center gap-2 mt-2 text-xs text-white/60"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {streamingState.isStreaming ? (
                <>
                  <Wifi className="h-3 w-3 text-green-500" />
                  <span className="text-green-500">Live streaming enabled</span>
                </>
              ) : (
                <>
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  Auto-refreshing every 5 seconds
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </BrandCard>
  );
}
