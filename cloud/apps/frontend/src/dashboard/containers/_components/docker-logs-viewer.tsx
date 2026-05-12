/**
 * Docker Logs Viewer — fetches raw docker logs for a agent sandbox container.
 * Calls the admin API at /api/v1/admin/docker-containers/[id]/logs.
 * Only rendered if the current user is an admin.
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
import { Copy, Download, RefreshCw, Search, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface DockerLogsViewerProps {
  sandboxId: string; // agent_sandbox.id (UUID)
  containerName: string; // for display
  nodeId: string; // node identifier
}

interface LogsState {
  raw: string;
  lines: string[];
  loading: boolean;
  error: string | null;
  fetchedAt: string | null;
}

export function DockerLogsViewer({ sandboxId, containerName, nodeId }: DockerLogsViewerProps) {
  const [logsState, setLogsState] = useState<LogsState>({
    raw: "",
    lines: [],
    loading: true,
    error: null,
    fetchedAt: null,
  });
  const [lineCount, setLineCount] = useState("200");
  const [searchQuery, setSearchQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    setLogsState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const params = new URLSearchParams({ lines: lineCount });
      const res = await fetch(`/api/v1/admin/docker-containers/${sandboxId}/logs?${params}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const raw: string = data.data.logs ?? "";
      setLogsState({
        raw,
        lines: raw.split("\n").filter(Boolean),
        loading: false,
        error: null,
        fetchedAt: data.data.fetchedAt ?? new Date().toISOString(),
      });
      // Scroll to bottom
      setTimeout(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }, 50);
    } catch (err) {
      setLogsState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [sandboxId, lineCount]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const filteredLines = logsState.lines.filter(
    (line) => !searchQuery || line.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const downloadLogs = () => {
    const blob = new Blob([logsState.raw], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${containerName}-docker-logs-${new Date().toISOString()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyAllLogs = async () => {
    await navigator.clipboard.writeText(logsState.raw);
    toast.success("Logs copied to clipboard");
  };

  // Detect log level from line content
  const getLineClass = (line: string): string => {
    const l = line.toLowerCase();
    if (l.includes("error") || l.includes("fatal") || l.includes("panic"))
      return "text-red-400 border-l-red-500";
    if (l.includes("warn")) return "text-yellow-400 border-l-yellow-500";
    if (l.includes("info")) return "text-blue-300 border-l-blue-500";
    return "text-neutral-300 border-l-neutral-700";
  };

  return (
    <BrandCard className="relative shadow-lg shadow-black/50" cornerSize="sm">
      <div className="relative z-10 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-block w-2 h-2 rounded-full bg-[#FF5800]" />
              <h2
                className="text-xl font-normal text-white"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                Docker Logs
              </h2>
              <Badge
                variant="outline"
                className="border-blue-500/40 text-blue-400 bg-blue-500/10 text-[10px] px-1.5 py-0"
              >
                Admin
              </Badge>
            </div>
            <p className="text-sm text-white/60">
              {containerName} · node: {nodeId}
            </p>
            {logsState.fetchedAt && (
              <p className="text-xs text-white/40 mt-0.5">
                Fetched at {new Date(logsState.fetchedAt).toLocaleTimeString()}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Select value={lineCount} onValueChange={setLineCount}>
              <SelectTrigger className="w-[90px] h-8 rounded-none border-white/10 bg-black/40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-none border-white/10 bg-neutral-900">
                <SelectItem value="50">50 lines</SelectItem>
                <SelectItem value="100">100 lines</SelectItem>
                <SelectItem value="200">200 lines</SelectItem>
                <SelectItem value="500">500 lines</SelectItem>
                <SelectItem value="1000">1000 lines</SelectItem>
              </SelectContent>
            </Select>
            <BrandButton variant="outline" size="sm" onClick={fetchLogs} title="Refresh">
              <RefreshCw className={`h-4 w-4 ${logsState.loading ? "animate-spin" : ""}`} />
            </BrandButton>
            <BrandButton
              variant="outline"
              size="sm"
              onClick={copyAllLogs}
              disabled={!logsState.raw}
              title="Copy all"
            >
              <Copy className="h-4 w-4" />
            </BrandButton>
            <BrandButton
              variant="outline"
              size="sm"
              onClick={downloadLogs}
              disabled={!logsState.raw}
              title="Download"
            >
              <Download className="h-4 w-4" />
            </BrandButton>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
          <Input
            placeholder="Filter log lines..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 rounded-none border-white/10 bg-black/40 text-white placeholder:text-white/40 focus-visible:ring-[#FF5800]/50"
            style={{ fontFamily: "var(--font-roboto-mono)" }}
          />
        </div>

        {searchQuery && (
          <p className="text-xs text-white/50" style={{ fontFamily: "var(--font-roboto-mono)" }}>
            {filteredLines.length} / {logsState.lines.length} lines
          </p>
        )}

        {/* Log output */}
        <div>
          {logsState.loading && logsState.lines.length === 0 ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-full rounded-none" />
              <Skeleton className="h-5 w-full rounded-none" />
              <Skeleton className="h-5 w-3/4 rounded-none" />
            </div>
          ) : logsState.error ? (
            <div className="text-center py-8">
              <Terminal className="h-8 w-8 text-neutral-600 mx-auto mb-3" />
              <p className="text-red-400 text-sm mb-1">Failed to fetch logs</p>
              <p className="text-xs text-white/40">{logsState.error}</p>
              <BrandButton variant="outline" size="sm" onClick={fetchLogs} className="mt-4">
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </BrandButton>
            </div>
          ) : logsState.lines.length === 0 ? (
            <div className="text-center py-8">
              <Terminal className="h-8 w-8 text-neutral-600 mx-auto mb-3" />
              <p className="text-white/50 text-sm">No logs available</p>
            </div>
          ) : (
            <ScrollArea className="h-[500px] w-full rounded-none border border-white/10">
              <div
                ref={scrollRef}
                className="p-3 font-mono text-xs space-y-px"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {filteredLines.map((line, i) => (
                  <div
                    key={i}
                    className={`px-2 py-0.5 border-l-2 hover:bg-white/5 transition-colors whitespace-pre-wrap break-all ${getLineClass(line)}`}
                  >
                    {line}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
    </BrandCard>
  );
}
