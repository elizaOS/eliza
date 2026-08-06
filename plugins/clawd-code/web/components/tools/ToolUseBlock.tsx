"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  Terminal,
  FileText,
  FileEdit,
  FileSearch,
  Search,
  Globe,
  BookOpen,
  ClipboardList,
  Bot,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Tool icon mapping ────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, React.ElementType> = {
  bash: Terminal,
  read: FileText,
  write: FileText,
  edit: FileEdit,
  glob: FileSearch,
  grep: Search,
  webfetch: Globe,
  websearch: Globe,
  notebookedit: BookOpen,
  todowrite: ClipboardList,
  agent: Bot,
};

function getToolIcon(name: string): React.ElementType {
  return TOOL_ICONS[name.toLowerCase()] ?? Wrench;
}

const TOOL_LABELS: Record<string, string> = {
  bash: "Bash",
  read: "Read File",
  write: "Write File",
  edit: "Edit File",
  glob: "Glob",
  grep: "Grep",
  webfetch: "Web Fetch",
  websearch: "Web Search",
  notebookedit: "Notebook Edit",
  todowrite: "Todo",
  agent: "Agent",
};

function getToolLabel(name: string): string {
  return TOOL_LABELS[name.toLowerCase()] ?? name;
}

// ─── Elapsed timer ────────────────────────────────────────────────────────────

function ElapsedTimer({ startMs }: { startMs: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - startMs);
    }, 100);
    return () => clearInterval(interval);
  }, [startMs]);

  if (elapsed < 1000) return <span>{elapsed}ms</span>;
  return <span>{(elapsed / 1000).toFixed(1)}s</span>;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

interface StatusBadgeProps {
  isRunning: boolean;
  isError: boolean;
  startedAt: number;
  completedAt?: number;
}

function StatusBadge({
  isRunning,
  isError,
  startedAt,
  completedAt,
}: StatusBadgeProps) {
  if (isRunning) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-brand-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <ElapsedTimer startMs={startedAt} />
      </span>
    );
  }

  const duration = completedAt ? completedAt - startedAt : null;
  const durationStr = duration
    ? duration < 1000
      ? `${duration}ms`
      : `${(duration / 1000).toFixed(1)}s`
    : null;

  if (isError) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-red-400">
        <XCircle className="w-3.5 h-3.5" />
        {durationStr && <span>{durationStr}</span>}
        <span>Error</span>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-xs text-green-400">
      <CheckCircle2 className="w-3.5 h-3.5" />
      {durationStr && <span>{durationStr}</span>}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export interface ToolUseBlockProps {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: string | null;
  isError?: boolean;
  isRunning?: boolean;
  startedAt?: number;
  completedAt?: number;
  children?: React.ReactNode;
  defaultExpanded?: boolean;
}

export function ToolUseBlock({
  toolName,
  toolInput: _toolInput,
  toolResult: _toolResult,
  isError = false,
  isRunning = false,
  startedAt,
  completedAt,
  children,
  defaultExpanded = false,
}: ToolUseBlockProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded || isRunning);
  const startRef = useRef(startedAt ?? Date.now());

  // Auto-expand while running, retain state after completion
  useEffect(() => {
    if (isRunning) setIsExpanded(true);
  }, [isRunning]);

  const Icon = getToolIcon(toolName);
  const label = getToolLabel(toolName);

  const borderColor = isRunning
    ? "border-brand-600/40"
    : isError
    ? "border-red-800/50"
    : "border-surface-700";

  const headerBg = isRunning
    ? "bg-brand-950/30"
    : isError
    ? "bg-red-950/20"
    : "bg-surface-850";

  return (
    <div
      className={cn(
        "rounded-lg border overflow-hidden text-sm",
        borderColor
      )}
    >
      {/* Header row */}
      <button
        onClick={() => setIsExpanded((v) => !v)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors",
          headerBg,
          "hover:bg-surface-800"
        )}
      >
        {/* Expand icon */}
        <span className="text-surface-500 flex-shrink-0">
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </span>

        {/* Tool icon */}
        <span
          className={cn(
            "flex-shrink-0",
            isRunning
              ? "text-brand-400"
              : isError
              ? "text-red-400"
              : "text-surface-400"
          )}
        >
          <Icon className="w-4 h-4" />
        </span>

        {/* Tool name */}
        <span className="text-surface-200 font-medium flex-1 truncate">
          {label}
        </span>

        {/* Status */}
        <StatusBadge
          isRunning={isRunning}
          isError={isError}
          startedAt={startRef.current}
          completedAt={completedAt}
        />
      </button>

      {/* Expandable body */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeInOut" }}
            style={{ overflow: "hidden" }}
          >
            <div className="border-t border-surface-700 bg-surface-900">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
