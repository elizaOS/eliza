"use client";

import { cn, logger } from "@polyagent/shared";
import { FileText, Filter } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";

/**
 * Log structure for agent logs.
 */
interface Log {
  id: string;
  type: string;
  level: string;
  message: string;
  prompt?: string;
  completion?: string;
  thinking?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Agent logs component for displaying agent activity logs.
 *
 * Displays a list of logs for a specific agent with filtering by type and
 * level. Shows log details including prompts, completions, and metadata.
 * Supports expanding/collapsing log entries. Auto-refreshes every 5 seconds.
 *
 * Features:
 * - Log list display
 * - Type filtering
 * - Level filtering
 * - Expandable log entries
 * - Color-coded by type/level
 * - Auto-refresh (5s interval)
 * - Loading states
 *
 * @param props - AgentLogs component props
 * @returns Agent logs element
 *
 * @example
 * ```tsx
 * <AgentLogs agentId="agent-123" />
 * ```
 */
interface AgentLogsProps {
  agentId: string;
}

export function AgentLogs({ agentId }: AgentLogsProps) {
  const { getAccessToken } = useAuth();
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    const token = await getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }

    let url = `/api/agents/${agentId}/logs?limit=100`;
    if (typeFilter !== "all") url += `&type=${typeFilter}`;
    if (levelFilter !== "all") url += `&level=${levelFilter}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (res.ok) {
      const data = (await res.json()) as { success: boolean; logs: Log[] };
      if (data.success && data.logs) {
        setLogs(data.logs);
      }
    } else {
      logger.error("Failed to fetch logs", undefined, "AgentLogs");
    }
    setLoading(false);
  }, [agentId, typeFilter, levelFilter, getAccessToken]);

  useEffect(() => {
    fetchLogs();
    // Auto-refresh every 5 seconds
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  const toggleExpanded = (logId: string) => {
    const newExpanded = new Set(expanded);
    if (newExpanded.has(logId)) {
      newExpanded.delete(logId);
    } else {
      newExpanded.add(logId);
    }
    setExpanded(newExpanded);
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case "error":
        return "text-red-600";
      case "warn":
        return "text-yellow-600";
      case "debug":
        return "text-muted-foreground";
      default:
        return "text-blue-600";
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case "error":
        return "bg-red-500/10 border-red-500/20";
      case "trade":
        return "bg-green-500/10 border-green-500/20";
      case "chat":
        return "bg-blue-500/10 border-blue-500/20";
      case "tick":
        return "bg-purple-500/10 border-purple-500/20";
      case "post":
        return "bg-orange-500/10 border-orange-500/20";
      case "comment":
        return "bg-cyan-500/10 border-cyan-500/20";
      default:
        return "bg-muted/30 border-border/50";
    }
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="rounded-lg border border-border bg-card/50 p-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-4">
          <Filter className="h-5 w-5 text-muted-foreground" />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border border-border bg-muted px-3 py-2 text-foreground"
          >
            <option value="all">All Types</option>
            <option value="chat">Chat</option>
            <option value="tick">Tick</option>
            <option value="trade">Trade</option>
            <option value="post">Post</option>
            <option value="comment">Comment</option>
            <option value="error">Error</option>
            <option value="system">System</option>
          </select>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="rounded-lg border border-border bg-muted px-3 py-2 text-foreground"
          >
            <option value="all">All Levels</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
            <option value="debug">Debug</option>
          </select>
          <button
            onClick={fetchLogs}
            disabled={loading}
            className="rounded-lg bg-muted px-4 py-2 font-medium text-foreground transition-all hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Logs */}
      <div className="rounded-lg border border-border bg-card/50 p-4 backdrop-blur">
        {logs.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            <FileText className="mx-auto mb-4 h-12 w-12 opacity-50" />
            <p>No logs found</p>
          </div>
        ) : (
          <div className="space-y-2">
            {logs.map((log) => (
              <div
                key={log.id}
                className={cn("rounded-lg border p-3", getTypeColor(log.type))}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "font-mono font-semibold text-xs uppercase",
                          getLevelColor(log.level),
                        )}
                      >
                        {log.level}
                      </span>
                      <span className="text-muted-foreground text-xs">•</span>
                      <span className="text-muted-foreground text-xs uppercase">
                        {log.type}
                      </span>
                      <span className="text-muted-foreground text-xs">•</span>
                      <span className="text-muted-foreground text-xs">
                        {new Date(log.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-sm">{log.message}</div>

                    {(log.prompt ||
                      log.completion ||
                      log.thinking ||
                      log.metadata) && (
                      <button
                        onClick={() => toggleExpanded(log.id)}
                        className="mt-2 rounded bg-muted px-3 py-1 text-xs transition-all hover:bg-muted/80"
                      >
                        {expanded.has(log.id) ? "Hide Details" : "Show Details"}
                      </button>
                    )}

                    {expanded.has(log.id) && (
                      <div className="mt-3 space-y-2 text-xs">
                        {log.prompt && (
                          <div>
                            <div className="mb-1 font-medium text-muted-foreground">
                              Prompt:
                            </div>
                            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-black/30 p-2">
                              {log.prompt}
                            </pre>
                          </div>
                        )}
                        {log.completion && (
                          <div>
                            <div className="mb-1 font-medium text-muted-foreground">
                              Completion:
                            </div>
                            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-black/30 p-2">
                              {log.completion}
                            </pre>
                          </div>
                        )}
                        {log.thinking && (
                          <div>
                            <div className="mb-1 font-medium text-muted-foreground">
                              Thinking:
                            </div>
                            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-black/30 p-2">
                              {log.thinking}
                            </pre>
                          </div>
                        )}
                        {log.metadata && (
                          <div className="min-w-0">
                            <div className="mb-1 font-medium text-muted-foreground">
                              Metadata:
                            </div>
                            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2">
                              {JSON.stringify(log.metadata, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
