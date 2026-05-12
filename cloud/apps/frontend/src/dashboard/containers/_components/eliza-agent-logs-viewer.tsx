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
import { Copy, Download, FileText, RefreshCw, Search, Terminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

interface ElizaAgentLogsViewerProps {
  agentId: string;
  agentName: string;
  status: string;
  showAdvancedHint?: boolean;
}

interface LogsState {
  raw: string;
  lines: string[];
  loading: boolean;
  error: string | null;
  fetchedAt: string | null;
}

const STATUS_BADGE_STYLES: Record<string, string> = {
  running: "border-green-500/40 bg-green-500/10 text-green-400",
  provisioning: "border-blue-500/40 bg-blue-500/10 text-blue-400",
  pending: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400",
  stopped: "border-white/20 bg-white/5 text-white/70",
  disconnected: "border-orange-500/40 bg-orange-500/10 text-orange-400",
  error: "border-red-500/40 bg-red-500/10 text-red-400",
};

const STATUS_MESSAGES: Record<string, string> = {
  pending: "This agent has not been provisioned yet, so there are no bridge logs to show.",
  provisioning: "The agent is provisioning. Logs may appear once the bridge finishes starting.",
  stopped:
    "The agent is stopped. The bridge log viewer only shows logs while the agent is running.",
  disconnected: "The agent is disconnected, so live bridge logs may be stale or unavailable.",
  error:
    "The agent is in an error state. If the app logs are empty, check the admin Docker logs below for infrastructure details.",
};

function getLineClass(line: string): string {
  const normalized = line.toLowerCase();
  if (
    normalized.includes("error") ||
    normalized.includes("fatal") ||
    normalized.includes("panic")
  ) {
    return "border-l-red-500 text-red-300";
  }
  if (normalized.includes("warn")) {
    return "border-l-yellow-500 text-yellow-300";
  }
  if (normalized.includes("info")) {
    return "border-l-blue-500 text-blue-300";
  }
  return "border-l-neutral-700 text-neutral-300";
}

export function ElizaAgentLogsViewer({
  agentId,
  agentName,
  status,
  showAdvancedHint = false,
}: ElizaAgentLogsViewerProps) {
  const [logsState, setLogsState] = useState<LogsState>({
    raw: "",
    lines: [],
    loading: true,
    error: null,
    fetchedAt: null,
  });
  const [tail, setTail] = useState("200");
  const [searchQuery, setSearchQuery] = useState("");

  const fetchLogs = useCallback(async () => {
    setLogsState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const params = new URLSearchParams({ tail });
      const response = await fetch(`/api/compat/agents/${agentId}/logs?${params}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !(payload as { success?: boolean }).success) {
        throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
      }

      const raw =
        typeof (payload as { data?: unknown }).data === "string"
          ? (payload as { data: string }).data
          : "";

      setLogsState({
        raw,
        lines: raw.length > 0 ? raw.split("\n").filter(Boolean) : [],
        loading: false,
        error: null,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      setLogsState((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [agentId, tail]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const filteredLines = useMemo(
    () =>
      logsState.lines.filter(
        (line) => !searchQuery || line.toLowerCase().includes(searchQuery.toLowerCase()),
      ),
    [logsState.lines, searchQuery],
  );

  const copyAllLogs = async () => {
    if (!logsState.raw) return;
    await navigator.clipboard.writeText(logsState.raw);
    toast.success("Logs copied to clipboard");
  };

  const downloadLogs = () => {
    if (!logsState.raw) return;

    const blob = new Blob([logsState.raw], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${agentName || "eliza-agent"}-logs-${new Date().toISOString()}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  const statusHint = STATUS_MESSAGES[status] ?? null;

  return (
    <BrandCard className="relative shadow-lg shadow-black/50" cornerSize="sm">
      <div className="relative z-10 space-y-6">
        <div className="flex flex-col gap-4 border-b border-white/10 pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-[#FF5800]" />
              <h2
                className="text-xl font-normal text-white"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                Agent Logs
              </h2>
              <Badge
                variant="outline"
                className={STATUS_BADGE_STYLES[status] ?? STATUS_BADGE_STYLES.stopped}
              >
                {status}
              </Badge>
            </div>
            <p className="text-sm text-white/60">
              User-facing app logs from the agent bridge for {agentName || "this agent"}.
            </p>
            {showAdvancedHint && (
              <p className="mt-1 text-xs text-white/40">
                Raw container output stays separate in the admin Docker logs panel below.
              </p>
            )}
            {logsState.fetchedAt && (
              <p className="mt-1 text-xs text-white/40">
                Refreshed at {new Date(logsState.fetchedAt).toLocaleTimeString()}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={tail} onValueChange={setTail}>
              <SelectTrigger className="h-8 w-[100px] rounded-none border-white/10 bg-black/40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-none border-white/10 bg-neutral-900">
                <SelectItem value="100">100 lines</SelectItem>
                <SelectItem value="200">200 lines</SelectItem>
                <SelectItem value="500">500 lines</SelectItem>
                <SelectItem value="1000">1000 lines</SelectItem>
                <SelectItem value="2000">2000 lines</SelectItem>
              </SelectContent>
            </Select>
            <BrandButton variant="outline" size="sm" onClick={fetchLogs} title="Refresh logs">
              <RefreshCw className={`h-4 w-4 ${logsState.loading ? "animate-spin" : ""}`} />
            </BrandButton>
            <BrandButton
              variant="outline"
              size="sm"
              onClick={copyAllLogs}
              disabled={!logsState.raw}
              title="Copy all logs"
            >
              <Copy className="h-4 w-4" />
            </BrandButton>
            <BrandButton
              variant="outline"
              size="sm"
              onClick={downloadLogs}
              disabled={!logsState.raw}
              title="Download logs"
            >
              <Download className="h-4 w-4" />
            </BrandButton>
          </div>
        </div>

        {statusHint && status !== "running" && (
          <div className="flex items-start gap-3 border border-white/10 bg-black/30 p-4">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[#FF5800]" />
            <p className="text-sm text-white/70">{statusHint}</p>
          </div>
        )}

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
          <Input
            placeholder="Filter log lines..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="rounded-none border-white/10 bg-black/40 pl-9 text-white placeholder:text-white/40 focus-visible:ring-[#FF5800]/50"
            style={{ fontFamily: "var(--font-roboto-mono)" }}
          />
        </div>

        {searchQuery && (
          <p className="text-xs text-white/50" style={{ fontFamily: "var(--font-roboto-mono)" }}>
            {filteredLines.length} / {logsState.lines.length} lines
          </p>
        )}

        {logsState.loading && logsState.lines.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-full rounded-none" />
            <Skeleton className="h-5 w-full rounded-none" />
            <Skeleton className="h-5 w-3/4 rounded-none" />
          </div>
        ) : logsState.error ? (
          <div className="py-8 text-center">
            <Terminal className="mx-auto mb-3 h-8 w-8 text-neutral-600" />
            <p className="mb-1 text-sm text-red-400">Failed to fetch logs</p>
            <p className="text-xs text-white/40">{logsState.error}</p>
            <BrandButton variant="outline" size="sm" onClick={fetchLogs} className="mt-4">
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </BrandButton>
          </div>
        ) : logsState.lines.length === 0 ? (
          <div className="py-8 text-center">
            <Terminal className="mx-auto mb-3 h-8 w-8 text-neutral-600" />
            <p className="text-sm text-white/60">No logs available yet</p>
            <p className="mt-1 text-xs text-white/40">
              If the agent is starting up, give it a moment and refresh again.
            </p>
          </div>
        ) : filteredLines.length === 0 ? (
          <div className="py-8 text-center">
            <Search className="mx-auto mb-3 h-8 w-8 text-neutral-600" />
            <p className="text-sm text-white/60">No logs match your filter</p>
          </div>
        ) : (
          <ScrollArea className="h-[420px] w-full rounded-none border border-white/10">
            <div
              className="space-y-px p-3 font-mono text-xs"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {filteredLines.map((line, index) => (
                <div
                  key={`${line.slice(0, 120)}:${index}`}
                  className={`whitespace-pre-wrap break-all border-l-2 px-2 py-0.5 transition-colors hover:bg-white/5 ${getLineClass(line)}`}
                >
                  {line}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </BrandCard>
  );
}
