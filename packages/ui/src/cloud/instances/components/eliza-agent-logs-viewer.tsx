"use client";

/**
 * Log viewer for a cloud agent instance, streaming/paging the agent's logs.
 */
import { LogViewer } from "@elizaos/ui/cloud-ui";
import { FileText } from "lucide-react";
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

interface LogsApiResponse {
  success?: boolean;
  error?: string;
  data?: string | LogsJobPayload;
}

interface LogsJobPayload {
  jobId?: string;
  status?: string;
  polling?: {
    endpoint?: string;
    intervalMs?: number;
    expectedDurationMs?: number;
  };
}

interface LogsJobResult {
  logs?: string;
  message?: string;
  error?: string;
}

interface LogsJobStatusResponse {
  success?: boolean;
  error?: string;
  data?: {
    status?: string;
    result?: LogsJobResult | null;
    error?: string | null;
  };
  polling?: {
    intervalMs?: number;
    shouldContinue?: boolean;
  };
}

const LOG_JOB_TIMEOUT_MS = 30_000;

const STATUS_BADGE_STYLES: Record<string, string> = {
  running: "border-green-500/40 bg-green-500/10 text-green-400",
  provisioning: "border-white/20 bg-white/5 text-white/80",
  pending: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400",
  stopped: "border-white/20 bg-white/5 text-white/70",
  disconnected: "border-orange-500/40 bg-orange-500/10 text-orange-400",
  error: "border-red-500/40 bg-red-500/10 text-red-400",
};

const STATUS_MESSAGES: Record<string, string> = {
  pending:
    "This agent has not been provisioned yet, so there are no bridge logs to show.",
  provisioning:
    "The agent is provisioning. Logs may appear once the bridge finishes starting.",
  stopped:
    "The agent is stopped. The bridge log viewer only shows logs while the agent is running.",
  disconnected:
    "The agent is disconnected, so live bridge logs may be stale or unavailable.",
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
    return "border-l-white/40 text-white/70";
  }
  return "border-l-neutral-700 text-neutral-300";
}

function isLogsJobPayload(
  data: LogsApiResponse["data"],
): data is LogsJobPayload {
  return (
    typeof data === "object" && data !== null && typeof data.jobId === "string"
  );
}

function splitLines(raw: string): string[] {
  return raw.length > 0 ? raw.split("\n").filter(Boolean) : [];
}

function logsJobResultToRaw(result: LogsJobResult | null | undefined): string {
  if (typeof result?.logs === "string" && result.logs.length > 0) {
    return result.logs;
  }
  if (typeof result?.message === "string" && result.message.length > 0) {
    return result.message;
  }
  return "";
}

async function waitForLogsJob(
  endpoint: string,
  initialIntervalMs: number,
): Promise<string> {
  const deadline = Date.now() + LOG_JOB_TIMEOUT_MS;
  let intervalMs = initialIntervalMs;

  while (Date.now() <= deadline) {
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload: LogsJobStatusResponse = await response
      .json()
      .catch(() => ({}));

    if (!response.ok || !payload.success) {
      throw new Error(payload.error ?? `HTTP ${response.status}`);
    }

    const status = payload.data?.status;
    if (status === "completed") {
      if (payload.data?.result?.error) {
        throw new Error(payload.data.result.error);
      }
      return logsJobResultToRaw(payload.data?.result);
    }
    if (status === "failed") {
      throw new Error(
        payload.data?.error ??
          payload.data?.result?.error ??
          "Log collection failed",
      );
    }

    const nextIntervalMs = payload.polling?.intervalMs ?? intervalMs;
    intervalMs = Math.min(Math.max(nextIntervalMs, 500), 5_000);
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
  }

  return "Log collection is still running. Refresh again in a moment.";
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
      const response = await fetch(
        `/api/compat/agents/${agentId}/logs?${params}`,
        {
          cache: "no-store",
        },
      );
      const payload: LogsApiResponse = await response.json().catch(() => ({}));

      if (!response.ok || !payload.success) {
        throw new Error(
          payload.error ??
            (response.ok
              ? "Log response did not include log data"
              : `HTTP ${response.status}`),
        );
      }

      const raw = isLogsJobPayload(payload.data)
        ? await waitForLogsJob(
            payload.data.polling?.endpoint ??
              `/api/v1/jobs/${payload.data.jobId}`,
            payload.data.polling?.intervalMs ?? 2_000,
          )
        : typeof payload.data === "string"
          ? payload.data
          : "";

      setLogsState({
        raw,
        lines: splitLines(raw),
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
        (line) =>
          !searchQuery ||
          line.toLowerCase().includes(searchQuery.toLowerCase()),
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
    <LogViewer
      title="Agent Logs"
      subtitle={`User-facing app logs from the agent bridge for ${
        agentName || "this agent"
      }.`}
      badges={[
        {
          label: status,
          variant: "outline",
          className: STATUS_BADGE_STYLES[status] ?? STATUS_BADGE_STYLES.stopped,
        },
      ]}
      fetchedAt={logsState.fetchedAt}
      lineCountControl={{
        value: tail,
        onChange: setTail,
        options: [
          { value: "100", label: "100 lines" },
          { value: "200", label: "200 lines" },
          { value: "500", label: "500 lines" },
          { value: "1000", label: "1000 lines" },
          { value: "2000", label: "2000 lines" },
        ],
      }}
      childrenBeforeSearch={
        <>
          {showAdvancedHint && (
            <p className="text-xs text-white/40">
              Raw container output stays separate in the admin Docker logs panel
              below.
            </p>
          )}
          {statusHint && status !== "running" && (
            <div className="flex items-start gap-3 border border-white/10 bg-black/30 p-4">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
              <p className="text-sm text-white/70">{statusHint}</p>
            </div>
          )}
        </>
      }
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
      emptyState={{
        title: "No logs available yet",
        description:
          "If the agent is starting up, give it a moment and refresh again.",
      }}
      filteredEmptyState={{ title: "No logs match your filter" }}
      isFilteredEmpty={logsState.lines.length > 0 && filteredLines.length === 0}
      lines={filteredLines}
      lineClassName={getLineClass}
      heightClassName="h-[420px]"
      onRefresh={fetchLogs}
      onCopyAll={copyAllLogs}
      onDownload={downloadLogs}
      copyDisabled={!logsState.raw}
      downloadDisabled={!logsState.raw}
    />
  );
}
