import * as React from "react";
import { Badge } from "./badge";

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];
export interface LogViewerBadge {
  key?: string;
  label: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}
export interface LogViewerSelectOption {
  value: string;
  label: string;
}
export interface LogViewerSelectControl {
  value: string;
  onChange: (value: string) => void;
  options: LogViewerSelectOption[];
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
export declare function LogViewer({
  title,
  subtitle,
  badges,
  fetchedAt,
  childrenBeforeSearch,
  search,
  levelFilter,
  lineCountControl,
  loading,
  error,
  errorTitle,
  retryLabel,
  onRetry,
  showRetryOnError,
  emptyState,
  filteredEmptyState,
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
  refreshTitle,
  copyTitle,
  downloadTitle,
  streamingTitle,
  heightClassName,
  contentRef,
  lineClassName,
  entryClassName,
  entryLevelVariant,
  entryLevelBorderColor,
  onCopyEntry,
  className,
}: LogViewerProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=log-viewer.d.ts.map
