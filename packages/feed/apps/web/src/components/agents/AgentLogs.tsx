"use client";

import { cn, logger } from "@feed/shared";
import { FileText, Filter } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { apiUrl } from "@/utils/api-url";

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

    let url = apiUrl(`/api/agents/${agentId}/logs?limit=100`);
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
      <div className="flex items-center gap-2">
        <Filter className="h-4 w-4 shrink-0 text-muted-foreground" />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-muted px-2 py-1.5 text-xs"
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
          className="min-w-0 flex-1 rounded-md border border-border bg-muted px-2 py-1.5 text-xs"
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
          className="shrink-0 rounded-md border border-border px-2 py-1.5 font-medium text-xs transition-colors hover:bg-muted disabled:opacity-50"
        >
          {loading ? "..." : "Refresh"}
        </button>
      </div>

      {/* Logs */}
      {logs.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          <FileText className="mx-auto mb-3 h-8 w-8 opacity-50" />
          <p className="text-sm">No logs found</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {logs.map((log) => (
            <div
              key={log.id}
              className={cn("rounded-lg border p-2.5", getTypeColor(log.type))}
            >
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span
                  className={cn(
                    "font-mono font-semibold text-[10px] uppercase",
                    getLevelColor(log.level),
                  )}
                >
                  {log.level}
                </span>
                <span className="text-[10px] text-muted-foreground">·</span>
                <span className="text-[10px] text-muted-foreground uppercase">
                  {log.type}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {new Date(log.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="text-xs leading-relaxed">{log.message}</div>

              {(log.prompt ||
                log.completion ||
                log.thinking ||
                log.metadata) && (
                <button
                  onClick={() => toggleExpanded(log.id)}
                  className="mt-1.5 rounded bg-muted px-2 py-0.5 text-[10px] transition-colors hover:bg-muted/80"
                >
                  {expanded.has(log.id) ? "Hide" : "Details"}
                </button>
              )}

              {expanded.has(log.id) && (
                <div className="mt-2 space-y-2 text-[11px]">
                  {log.prompt && (
                    <div>
                      <div className="mb-0.5 font-medium text-[10px] text-muted-foreground">
                        Prompt
                      </div>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2">
                        {log.prompt}
                      </pre>
                    </div>
                  )}
                  {log.completion && (
                    <div>
                      <div className="mb-0.5 font-medium text-[10px] text-muted-foreground">
                        Completion
                      </div>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2">
                        {log.completion}
                      </pre>
                    </div>
                  )}
                  {log.thinking && (
                    <div>
                      <div className="mb-0.5 font-medium text-[10px] text-muted-foreground">
                        Thinking
                      </div>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2">
                        {log.thinking}
                      </pre>
                    </div>
                  )}
                  {log.metadata && (
                    <div>
                      <div className="mb-0.5 font-medium text-[10px] text-muted-foreground">
                        Metadata
                      </div>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
