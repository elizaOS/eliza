"use client";

/**
 * Log viewer with copy/download and follow-tail, used by the cloud agent-logs surface.
 */
import { formatTime } from "@elizaos/shared/utils/format";
import {
  Copy,
  Download,
  RefreshCw,
  Search,
  Terminal,
  Wifi,
  WifiOff,
} from "lucide-react";
import * as React from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../lib/utils";
import { CornerBrackets } from "./brand/corner-brackets";

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];
type BadgeTone = React.ComponentProps<typeof Badge>["tone"];
type BadgeSize = React.ComponentProps<typeof Badge>["size"];

export interface LogViewerBadge {
  key?: string;
  label: React.ReactNode;
  variant?: BadgeVariant;
  tone?: BadgeTone;
  size?: BadgeSize;
}

export interface LogViewerSelectOption {
  value: string;
  label: string;
}

export interface LogViewerSelectControl {
  value: string;
  onChange: (value: string) => void;
  options: LogViewerSelectOption[];
  ariaLabel?: string;
  triggerClassName?: string;
}

export interface LogViewerSearchControl {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  resultLabel?: React.ReactNode;
}

export interface LogViewerStructuredEntry {
  id?: string;
  timestamp?: string | number | Date;
  level?: string;
  message: string;
  metadata?: unknown;
}

export interface LogViewerStreamingStatus {
  enabled: boolean;
  active: boolean;
  label?: string;
  activeLabel?: string;
  inactiveLabel?: string;
}

export interface LogViewerEmptyState {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export interface LogViewerProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  badges?: LogViewerBadge[];
  fetchedAt?: string | number | Date | null;
  childrenBeforeSearch?: React.ReactNode;
  search?: LogViewerSearchControl;
  levelFilter?: LogViewerSelectControl;
  lineCountControl?: LogViewerSelectControl;
  loading?: boolean;
  error?: React.ReactNode;
  errorTitle?: React.ReactNode;
  retryLabel?: React.ReactNode;
  onRetry?: () => void;
  showRetryOnError?: boolean;
  emptyState?: LogViewerEmptyState;
  filteredEmptyState?: LogViewerEmptyState;
  isFilteredEmpty?: boolean;
  lines?: string[];
  entries?: LogViewerStructuredEntry[];
  onRefresh?: () => void;
  onCopyAll?: () => void;
  onDownload?: () => void;
  onToggleStreaming?: () => void;
  streaming?: LogViewerStreamingStatus;
  copyDisabled?: boolean;
  downloadDisabled?: boolean;
  refreshTitle?: string;
  copyTitle?: string;
  downloadTitle?: string;
  streamingTitle?: string;
  heightClassName?: string;
  contentRef?: React.Ref<HTMLDivElement>;
  lineClassName?: (line: string) => string;
  entryClassName?: (entry: LogViewerStructuredEntry) => string;
  entryLevelVariant?: (level: string) => BadgeVariant;
  entryLevelBorderColor?: (level: string) => string;
  onCopyEntry?: (entry: LogViewerStructuredEntry) => void;
  className?: string;
}

function getDefaultLineClassName(line: string): string {
  const normalized = line.toLowerCase();
  if (
    normalized.includes("error") ||
    normalized.includes("fatal") ||
    normalized.includes("panic")
  ) {
    return "border-l-destructive text-destructive";
  }
  if (normalized.includes("warn"))
    return "border-l-status-warning text-status-warning";
  if (normalized.includes("info"))
    return "border-l-status-info text-status-info";
  return "border-l-neutral-700 text-neutral-300";
}

function getDefaultEntryLevelVariant(level: string): BadgeVariant {
  switch (level) {
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

function getDefaultEntryClassName(entry: LogViewerStructuredEntry): string {
  switch (entry.level) {
    case "error":
      return "text-destructive";
    case "warn":
      return "text-status-warning";
    case "info":
      return "text-status-info";
    case "debug":
      return "text-gray-500";
    default:
      return "text-foreground";
  }
}

function renderMetadata(metadata: unknown): React.ReactNode {
  if (
    !metadata ||
    (typeof metadata === "object" && Object.keys(metadata).length === 0)
  ) {
    return null;
  }
  return JSON.stringify(metadata);
}

export function LogViewer({
  title,
  subtitle,
  badges = [],
  fetchedAt,
  childrenBeforeSearch,
  search,
  levelFilter,
  lineCountControl,
  loading = false,
  error,
  errorTitle = "Failed to fetch logs",
  retryLabel = "Retry",
  onRetry,
  showRetryOnError = true,
  emptyState = { title: "No logs available" },
  filteredEmptyState = { title: "No logs match your filter" },
  isFilteredEmpty: isFilteredEmptyOverride,
  lines,
  entries,
  onRefresh,
  onCopyAll,
  onDownload,
  onToggleStreaming,
  streaming,
  copyDisabled,
  downloadDisabled,
  refreshTitle = "Refresh logs",
  copyTitle = "Copy all logs",
  downloadTitle = "Download logs",
  streamingTitle,
  heightClassName = entries ? "h-[400px]" : "h-[500px]",
  contentRef,
  lineClassName = getDefaultLineClassName,
  entryClassName = getDefaultEntryClassName,
  entryLevelVariant = getDefaultEntryLevelVariant,
  entryLevelBorderColor,
  onCopyEntry,
  className,
}: LogViewerProps) {
  const itemCount = entries?.length ?? lines?.length ?? 0;
  const isFilteredEmpty =
    isFilteredEmptyOverride ??
    (itemCount === 0 &&
      Boolean(search?.value || (levelFilter && levelFilter.value !== "all")));
  const hasData = itemCount > 0;
  const renderedLines = React.useMemo(() => {
    const seen = new Map<string, number>();
    return lines?.map((line) => {
      const occurrence = (seen.get(line) ?? 0) + 1;
      seen.set(line, occurrence);
      return {
        line,
        key: `${line.slice(0, 120)}:${line.length}:${occurrence}`,
      };
    });
  }, [lines]);

  return (
    <Card variant="brand" className={cn("relative ", className)}>
      <CornerBrackets size="sm" />
      <div className="relative z-10 space-y-6">
        <div className="flex flex-col gap-4 border-b border-border pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="inline-block size-2 rounded-full bg-txt" />
              <h2
                className="text-xl font-normal text-white"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {title}
              </h2>
              {badges.map((badge) => (
                <Badge
                  key={badge.key ?? String(badge.label)}
                  variant={badge.variant ?? "outline"}
                  tone={badge.tone}
                  size={badge.size}
                >
                  {badge.label}
                </Badge>
              ))}
            </div>
            {subtitle && <p className="text-sm text-white/60">{subtitle}</p>}
            {fetchedAt != null && fetchedAt !== "" && (
              <p className="mt-1 text-xs text-white/60">
                Refreshed at {formatTime(fetchedAt)}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {lineCountControl && (
              <Select
                value={lineCountControl.value}
                onValueChange={lineCountControl.onChange}
              >
                <SelectTrigger
                  aria-label={lineCountControl.ariaLabel ?? "Log line count"}
                  className={cn(
                    "h-8 w-[100px] rounded-none border-border bg-black/40 text-xs",
                    lineCountControl.triggerClassName,
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-none border-border bg-neutral-900">
                  {lineCountControl.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {onToggleStreaming && (
              <Button
                aria-label={
                  streamingTitle ??
                  (streaming?.active ? "Stop streaming logs" : "Stream logs")
                }
                variant="outline"
                size="sm"
                onClick={onToggleStreaming}
                title={streamingTitle}
              >
                {streaming?.active ? (
                  <Wifi className="size-4" />
                ) : streaming?.enabled ? (
                  <RefreshCw className="size-4 animate-spin" />
                ) : (
                  <WifiOff className="size-4" />
                )}
              </Button>
            )}
            {onRefresh && (
              <Button
                aria-label={refreshTitle}
                variant="outline"
                size="sm"
                onClick={onRefresh}
                title={refreshTitle}
              >
                <RefreshCw
                  className={cn("size-4", loading && "animate-spin")}
                />
              </Button>
            )}
            {onCopyAll && (
              <Button
                aria-label={copyTitle}
                variant="outline"
                size="sm"
                onClick={onCopyAll}
                disabled={copyDisabled}
                title={copyTitle}
              >
                <Copy className="size-4" />
              </Button>
            )}
            {onDownload && (
              <Button
                aria-label={downloadTitle}
                variant="outline"
                size="sm"
                onClick={onDownload}
                disabled={downloadDisabled}
                title={downloadTitle}
              >
                <Download className="size-4" />
              </Button>
            )}
          </div>
        </div>

        {childrenBeforeSearch}

        {(search || levelFilter) && (
          <div className="flex flex-col gap-3 sm:flex-row">
            {search && (
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/60" />
                <Input
                  variant="config"
                  adornment="leading"
                  aria-label={search.placeholder ?? "Search logs"}
                  placeholder={search.placeholder ?? "Search logs..."}
                  value={search.value}
                  onChange={(event) => search.onChange(event.target.value)}
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                />
              </div>
            )}
            {levelFilter && (
              <Select
                value={levelFilter.value}
                onValueChange={levelFilter.onChange}
              >
                <SelectTrigger
                  aria-label={levelFilter.ariaLabel ?? "Log level"}
                  className={cn(
                    "w-full rounded-none border-border bg-black/40 sm:w-[140px]",
                    levelFilter.triggerClassName,
                  )}
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-none border-border bg-card">
                  {levelFilter.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}

        {search?.resultLabel && (
          <p
            className="text-xs text-white/50"
            style={{ fontFamily: "var(--font-roboto-mono)" }}
          >
            {search.resultLabel}
          </p>
        )}

        {loading && !hasData ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-full rounded-none" />
            <Skeleton className="h-5 w-full rounded-none" />
            <Skeleton className="h-5 w-3/4 rounded-none" />
          </div>
        ) : error ? (
          <div className="py-8 text-center">
            <Terminal className="mx-auto mb-3 size-8 text-neutral-600" />
            <p
              className="mb-1 text-sm font-medium text-destructive"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {errorTitle}
            </p>
            <p className="text-xs text-white/60">{error}</p>
            {showRetryOnError && onRetry && (
              <Button
                variant="outline"
                size="sm"
                onClick={onRetry}
                className="mt-4"
              >
                <RefreshCw className="mr-2 size-4" />
                {retryLabel}
              </Button>
            )}
          </div>
        ) : !hasData ? (
          <div className="py-8 text-center">
            <Terminal className="mx-auto mb-3 size-8 text-neutral-600" />
            <p className="text-sm text-white/60">
              {isFilteredEmpty ? filteredEmptyState.title : emptyState.title}
            </p>
            {(isFilteredEmpty
              ? filteredEmptyState.description
              : emptyState.description) && (
              <p className="mt-1 text-xs text-white/60">
                {isFilteredEmpty
                  ? filteredEmptyState.description
                  : emptyState.description}
              </p>
            )}
            {(isFilteredEmpty
              ? filteredEmptyState.action
              : emptyState.action) && (
              <div className="mt-4">
                {isFilteredEmpty
                  ? filteredEmptyState.action
                  : emptyState.action}
              </div>
            )}
          </div>
        ) : (
          <ScrollArea
            variant="borderedSquare"
            className={cn("w-full", heightClassName)}
          >
            <div
              ref={contentRef}
              className={cn(
                "space-y-px p-3 font-mono text-xs",
                entries && "space-y-1 p-4 text-sm",
              )}
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {renderedLines?.map(({ line, key }) => (
                <div
                  key={key}
                  className={cn(
                    "whitespace-pre-wrap break-all border-l-2 px-2 py-0.5 transition-colors hover:bg-white/5",
                    lineClassName(line),
                  )}
                >
                  {line}
                </div>
              ))}
              {entries?.map((entry, index) => (
                <div
                  key={entry.id ?? `${entry.timestamp ?? ""}-${index}`}
                  className={cn(
                    "group flex gap-3 rounded-none border-l-2 p-2 transition-colors hover:bg-white/5",
                    entryClassName(entry),
                  )}
                  style={{
                    borderLeftColor: entryLevelBorderColor?.(entry.level ?? ""),
                  }}
                >
                  {entry.level && (
                    <Badge
                      variant={entryLevelVariant(entry.level)}
                      size="compact"
                      className="shrink-0"
                    >
                      {entry.level.toUpperCase()}
                    </Badge>
                  )}
                  {entry.timestamp != null && entry.timestamp !== "" && (
                    <span className="min-w-[70px] shrink-0 text-xs text-white/60">
                      {formatTime(entry.timestamp)}
                    </span>
                  )}
                  <span className="flex-1 whitespace-pre-wrap break-all text-white/80">
                    {entry.message}
                  </span>
                  {(() => {
                    const meta = renderMetadata(entry.metadata);
                    return (
                      meta && (
                        <span className="max-w-[200px] truncate text-xs text-white/50">
                          {meta}
                        </span>
                      )
                    );
                  })()}
                  {onCopyEntry && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onCopyEntry(entry)}
                      className="size-6 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100"
                      title="Copy log line"
                    >
                      <Copy className="size-3" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        {streaming?.enabled && (
          <div
            className="mt-2 flex items-center justify-center gap-2 text-xs text-white/60"
            style={{ fontFamily: "var(--font-roboto-mono)" }}
          >
            {streaming.active ? (
              <>
                <Wifi className="size-3 text-status-success" />
                <span className="text-status-success">
                  {streaming.activeLabel ??
                    streaming.label ??
                    "Live streaming enabled"}
                </span>
              </>
            ) : (
              <>
                <RefreshCw className="size-3 animate-spin" />
                {streaming.inactiveLabel ??
                  streaming.label ??
                  "Auto-refreshing"}
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
