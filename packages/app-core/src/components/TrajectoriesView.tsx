/**
 * TrajectoriesView — view and analyze LLM call trajectories.
 *
 * Shows all captured LLM interactions with token counts, latency, and context.
 * Supports filtering, search, export, and clearing trajectories.
 */

import {
  client,
  type TrajectoryConfig,
  type TrajectoryListResult,
  type TrajectoryRecord,
  type TrajectoryStats,
} from "@elizaos/app-core/api";
import { useApp } from "@elizaos/app-core/state";
import { confirmDesktopAction } from "@elizaos/app-core/utils";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import {
  formatTrajectoryDuration,
  formatTrajectoryTimestamp,
  formatTrajectoryTokenCount,
} from "./trajectory-format";

type StatusFilter = "" | "active" | "completed" | "error";

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  active: { bg: "rgba(59, 130, 246, 0.15)", fg: "rgb(59, 130, 246)" },
  completed: { bg: "rgba(34, 197, 94, 0.15)", fg: "rgb(34, 197, 94)" },
  error: { bg: "rgba(239, 68, 68, 0.15)", fg: "rgb(239, 68, 68)" },
};

const SOURCE_COLORS: Record<string, { bg: string; fg: string }> = {
  chat: { bg: "rgba(99, 102, 241, 0.15)", fg: "rgb(99, 102, 241)" },
  autonomy: { bg: "rgba(245, 158, 11, 0.15)", fg: "rgb(245, 158, 11)" },
  telegram: { bg: "rgba(34, 197, 94, 0.15)", fg: "rgb(34, 197, 94)" },
  discord: { bg: "rgba(88, 101, 242, 0.15)", fg: "rgb(88, 101, 242)" },
  api: { bg: "rgba(156, 163, 175, 0.15)", fg: "rgb(156, 163, 175)" },
  orchestrator: { bg: "rgba(168, 85, 247, 0.15)", fg: "rgb(168, 85, 247)" },
};

interface TrajectoriesViewProps {
  onSelectTrajectory?: (id: string) => void;
}

export function TrajectoriesView({
  onSelectTrajectory,
}: TrajectoriesViewProps) {
  const { t } = useApp();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<TrajectoryListResult | null>(null);
  const [stats, setStats] = useState<TrajectoryStats | null>(null);
  const [config, setConfig] = useState<TrajectoryConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 50;

  // Actions
  const [exporting, setExporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [updatingLogging, setUpdatingLogging] = useState(false);

  const loadTrajectories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [trajResult, statsResult, configResult] = await Promise.all([
        client.getTrajectories({
          limit: pageSize,
          offset: page * pageSize,
          status: statusFilter || undefined,
          source: sourceFilter || undefined,
          search: searchQuery || undefined,
        }),
        client.getTrajectoryStats(),
        client.getTrajectoryConfig(),
      ]);
      setResult(trajResult);
      setStats(statsResult);
      setConfig(configResult);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("trajectoriesview.FailedToLoad"),
      );
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, sourceFilter, searchQuery, t]);

  useEffect(() => {
    void loadTrajectories();
  }, [loadTrajectories]);

  const handleToggleLogging = async () => {
    if (!config) return;
    setUpdatingLogging(true);
    try {
      const updated = await client.updateTrajectoryConfig({
        enabled: !config.enabled,
      });
      setConfig(updated);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("trajectoriesview.FailedToUpdateConfig"),
      );
    } finally {
      setUpdatingLogging(false);
    }
  };

  const handleExport = async (
    format: "json" | "csv" | "zip",
    includePrompts: boolean,
  ) => {
    setExporting(true);
    try {
      const blob = await client.exportTrajectories({ format, includePrompts });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `trajectories-${new Date().toISOString().split("T")[0]}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("trajectoriesview.FailedToExport"),
      );
    } finally {
      setExporting(false);
    }
  };

  const handleClearAll = async () => {
    const confirmed = await confirmDesktopAction({
      title: t("trajectoriesview.DeleteAllTitle"),
      message: t("trajectoriesview.DeleteAllMessage"),
      detail: t("trajectoriesview.DeleteAllDetail"),
      confirmLabel: t("common.deleteAll"),
      cancelLabel: t("common.cancel"),
      type: "warning",
    });
    if (!confirmed) {
      return;
    }
    setClearing(true);
    try {
      await client.clearAllTrajectories();
      void loadTrajectories();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("trajectoriesview.FailedToClear"),
      );
    } finally {
      setClearing(false);
    }
  };

  const handleClearFilters = () => {
    setStatusFilter("");
    setSourceFilter("");
    setSearchQuery("");
    setPage(0);
  };

  const hasActiveFilters =
    statusFilter !== "" || sourceFilter !== "" || searchQuery !== "";
  const trajectories = result?.trajectories ?? [];
  const total = result?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  const sources = stats?.bySource ? Object.keys(stats.bySource) : [];

  return (
    <div className="flex flex-col h-full gap-3" data-testid="trajectories-view">
      {/* Stats summary */}
      {stats && (
        <div className="flex flex-wrap gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-muted">{t("trajectoriesview.Total")}</span>
            <span className="font-semibold">
              {stats.totalTrajectories.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted">{t("trajectoriesview.LLMCalls")}</span>
            <span className="font-semibold">
              {stats.totalLlmCalls.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted">{t("trajectoriesview.Tokens")}</span>
            <span className="font-semibold text-txt">
              {formatTrajectoryTokenCount(
                stats.totalPromptTokens + stats.totalCompletionTokens,
                { emptyLabel: "0" },
              )}
            </span>
            <span className="text-muted text-[10px]">
              (
              {formatTrajectoryTokenCount(stats.totalPromptTokens, {
                emptyLabel: "0",
              })}
              ↑{" "}
              {formatTrajectoryTokenCount(stats.totalCompletionTokens, {
                emptyLabel: "0",
              })}
              ↓)
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted">
              {t("trajectoriesview.AvgDuration")}
            </span>
            <span className="font-semibold">
              {formatTrajectoryDuration(stats.averageDurationMs)}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-muted">
                {t("trajectoriesview.Logging")}
              </span>
              <Button
                variant="outline"
                size="sm"
                className={`h-6 px-2 py-0.5 text-[11px] shadow-sm ${
                  config?.enabled
                    ? "bg-success/20 border-success text-success hover:bg-success/30"
                    : "bg-warn/20 border-warn text-warn hover:bg-warn/30"
                }`}
                onClick={handleToggleLogging}
                disabled={!config || updatingLogging}
                aria-pressed={config?.enabled ?? false}
              >
                {config?.enabled ? t("common.on") : t("common.off")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Filters row */}
      <div className="flex flex-wrap gap-1.5 items-center">
        <Input
          type="text"
          placeholder={t("trajectoriesview.Search")}
          className="h-8 px-3 py-1.5 text-xs bg-card border-border w-48 shadow-sm"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setPage(0);
          }}
        />

        <Select
          value={statusFilter === "" ? "all" : statusFilter}
          onValueChange={(val) => {
            setStatusFilter(val === "all" ? "" : (val as StatusFilter));
            setPage(0);
          }}
        >
          <SelectTrigger className="h-8 px-3 py-1.5 text-xs bg-card border-border shadow-sm w-36">
            <SelectValue placeholder={t("trajectoriesview.AllStatuses")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {t("trajectoriesview.AllStatuses")}
            </SelectItem>
            <SelectItem value="active">{t("appsview.Active")}</SelectItem>
            <SelectItem value="completed">
              {t("trajectoriesview.Completed")}
            </SelectItem>
            <SelectItem value="error">{t("logsview.Error")}</SelectItem>
          </SelectContent>
        </Select>

        {sources.length > 0 && (
          <Select
            value={sourceFilter === "" ? "all" : sourceFilter}
            onValueChange={(val) => {
              setSourceFilter(val === "all" ? "" : val);
              setPage(0);
            }}
          >
            <SelectTrigger className="h-8 px-3 py-1.5 text-xs bg-card border-border shadow-sm w-36">
              <SelectValue placeholder={t("logsview.AllSources")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("logsview.AllSources")}</SelectItem>
              {sources.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {hasActiveFilters && (
          <Button
            variant="outline"
            size="sm"
            className="h-auto min-h-[2rem] whitespace-normal break-words px-3 py-1.5 text-xs bg-card text-txt hover:text-txt shadow-sm text-left"
            onClick={handleClearFilters}
          >
            {t("logsview.ClearFilters")}
          </Button>
        )}

        <div className="ml-auto flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-auto min-h-[2rem] whitespace-normal break-words px-3 py-1.5 text-xs bg-card text-txt hover:text-txt shadow-sm text-left"
            onClick={() => void loadTrajectories()}
            disabled={loading}
          >
            {loading
              ? t("common.loading", { defaultValue: "Loading..." })
              : t("common.refresh", { defaultValue: "Refresh" })}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-auto min-h-[2rem] whitespace-normal break-words px-3 py-1.5 text-xs bg-card text-txt hover:text-txt shadow-sm text-left"
                disabled={exporting || trajectories.length === 0}
              >
                {exporting ? t("common.exporting") : t("common.export")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => handleExport("json", true)}>
                {t("trajectoriesview.JSONWithPrompts")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("json", false)}>
                {t("trajectoriesview.JSONRedacted")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("csv", false)}>
                {t("trajectoriesview.CSVSummaryOnly")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("zip", true)}>
                {t("trajectoriesview.ZIPFolders")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="outline"
            size="sm"
            className="h-auto min-h-[2rem] whitespace-normal break-words px-3 py-1.5 text-xs bg-card text-danger border-danger/50 hover:bg-danger/10 hover:border-danger shadow-sm text-left"
            onClick={handleClearAll}
            disabled={clearing || stats?.totalTrajectories === 0}
          >
            {clearing ? t("common.clearing") : t("common.clearAll")}
          </Button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="text-xs text-danger border border-danger/30 bg-danger/10 px-3 py-2">
          {error}
        </div>
      )}

      {/* Trajectories list */}
      <div className="flex-1 min-h-0 overflow-y-auto border border-border bg-card">
        {loading && trajectories.length === 0 ? (
          <div className="text-center py-8 text-muted">
            {t("trajectoriesview.LoadingTrajectories")}
          </div>
        ) : trajectories.length === 0 ? (
          <div className="text-center py-8 text-muted">
            {hasActiveFilters
              ? t("trajectoriesview.NoTrajectoriesMatchingFilters")
              : t("trajectoriesview.NoTrajectoriesYet")}
            {!config?.enabled && (
              <div className="mt-2 text-warn text-[11px]">
                {t("trajectoriesview.LoggingHelp")}
              </div>
            )}
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/10 sticky top-0">
              <tr>
                <th className="text-left px-2 py-1.5 font-medium">
                  {t("trajectoriesview.Time")}
                </th>
                <th className="text-left px-2 py-1.5 font-medium">
                  {t("trajectoriesview.Source")}
                </th>
                <th className="text-left px-2 py-1.5 font-medium">
                  {t("finetuningview.Status")}
                </th>
                <th className="text-right px-2 py-1.5 font-medium">
                  {t("trajectoriesview.Calls")}
                </th>
                <th className="text-right px-2 py-1.5 font-medium">
                  {t("trajectoriesview.Tokens1")}
                </th>
                <th className="text-right px-2 py-1.5 font-medium">
                  {t("trajectoriesview.Duration")}
                </th>
              </tr>
            </thead>
            <tbody>
              {trajectories.map((traj: TrajectoryRecord) => {
                const statusColor =
                  STATUS_COLORS[traj.status] ?? STATUS_COLORS.completed;
                const sourceColor =
                  SOURCE_COLORS[traj.source] ?? SOURCE_COLORS.api;
                return (
                  <tr
                    key={traj.id}
                    className="border-t border-border hover:bg-muted/5 cursor-pointer"
                    onClick={() => onSelectTrajectory?.(traj.id)}
                  >
                    <td className="px-2 py-1.5 text-muted whitespace-nowrap">
                      {formatTrajectoryTimestamp(traj.createdAt, "smart")}
                    </td>
                    <td className="px-2 py-1.5">
                      <span
                        className="inline-block text-[10px] px-1.5 py-px rounded"
                        style={{
                          background: sourceColor.bg,
                          color: sourceColor.fg,
                        }}
                      >
                        {traj.source}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <span
                        className="inline-block text-[10px] px-1.5 py-px rounded"
                        style={{
                          background: statusColor.bg,
                          color: statusColor.fg,
                        }}
                      >
                        {traj.status}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {traj.llmCallCount}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      <span className="text-txt">
                        {formatTrajectoryTokenCount(
                          traj.totalPromptTokens + traj.totalCompletionTokens,
                          { emptyLabel: "0" },
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted font-mono">
                      {formatTrajectoryDuration(traj.durationMs)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">
            {t("trajectoriesview.ShowingRange", {
              start: page * pageSize + 1,
              end: Math.min((page + 1) * pageSize, total),
              total,
            })}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-auto min-h-[1.75rem] px-2 py-1 text-xs bg-card disabled:opacity-50 shadow-sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              {t("databaseview.Prev")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-auto min-h-[1.75rem] px-2 py-1 text-xs bg-card disabled:opacity-50 shadow-sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages - 1}
            >
              {t("databaseview.Next")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
