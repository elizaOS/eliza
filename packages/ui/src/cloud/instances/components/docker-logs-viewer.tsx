/**
 * Docker Logs Viewer — raw docker logs for an agent sandbox container.
 * Calls the admin API at /api/v1/admin/docker-containers/[id]/logs.
 * Only rendered when the current user is an admin (the route 403s otherwise).
 */
"use client";

import { LogViewer } from "@elizaos/ui/cloud-ui";
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

export function DockerLogsViewer({
  sandboxId,
  containerName,
  nodeId,
}: DockerLogsViewerProps) {
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
      const res = await fetch(
        `/api/v1/admin/docker-containers/${sandboxId}/logs?${params}`,
      );
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
    (line) =>
      !searchQuery || line.toLowerCase().includes(searchQuery.toLowerCase()),
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

  const getLineClass = (line: string): string => {
    const l = line.toLowerCase();
    if (l.includes("error") || l.includes("fatal") || l.includes("panic"))
      return "text-red-400 border-l-red-500";
    if (l.includes("warn")) return "text-yellow-400 border-l-yellow-500";
    if (l.includes("info")) return "text-white/70 border-l-white/40";
    return "text-neutral-300 border-l-neutral-700";
  };

  return (
    <LogViewer
      title="Docker Logs"
      subtitle={`${containerName} · node: ${nodeId}`}
      badges={[
        {
          label: "Admin",
          variant: "outline",
          className:
            "border-white/20 bg-white/5 px-1.5 py-0 text-[10px] text-white/80",
        },
      ]}
      fetchedAt={logsState.fetchedAt}
      lineCountControl={{
        value: lineCount,
        onChange: setLineCount,
        triggerClassName: "w-[90px]",
        options: [
          { value: "50", label: "50 lines" },
          { value: "100", label: "100 lines" },
          { value: "200", label: "200 lines" },
          { value: "500", label: "500 lines" },
          { value: "1000", label: "1000 lines" },
        ],
      }}
      search={{
        value: searchQuery,
        onChange: setSearchQuery,
        placeholder: "Filter log lines...",
        resultLabel: searchQuery
          ? `${filteredLines.length} / ${logsState.lines.length} lines`
          : null,
      }}
      loading={logsState.loading}
      error={logsState.error}
      errorTitle="Failed to fetch logs"
      onRetry={fetchLogs}
      emptyState={{ title: "No logs available" }}
      filteredEmptyState={{ title: "No logs match your filter" }}
      isFilteredEmpty={logsState.lines.length > 0 && filteredLines.length === 0}
      lines={filteredLines}
      lineClassName={getLineClass}
      contentRef={scrollRef}
      heightClassName="h-[500px]"
      onRefresh={fetchLogs}
      refreshTitle="Refresh"
      onCopyAll={copyAllLogs}
      onDownload={downloadLogs}
      copyDisabled={!logsState.raw}
      downloadDisabled={!logsState.raw}
    />
  );
}
