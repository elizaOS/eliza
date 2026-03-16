"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  GitCommit,
  RotateCcw,
  Clock,
  User,
  Check,
  AlertCircle,
  Loader2,
  RefreshCw,
  ChevronRight,
  History,
  Circle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

interface HistoryTabProps {
  sessionId: string;
  className?: string;
  onRollbackComplete?: () => void;
  currentCommitSha?: string | null;
}

export function HistoryTab({
  sessionId,
  className,
  onRollbackComplete,
  currentCommitSha,
}: HistoryTabProps) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [rollbackingSha, setRollbackingSha] = useState<string | null>(null);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchCommits = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/app-builder/sessions/${sessionId}/history`,
      );
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.commits) {
          setCommits(data.commits);
        }
      } else {
        setError("Failed to fetch commit history");
      }
    } catch (err) {
      setError("Failed to connect to server");
      console.warn("[HistoryTab] Failed to fetch commits:", err);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchCommits();
  }, [fetchCommits]);

  const handleRollback = async (sha: string) => {
    if (rollbackingSha) return;

    const commit = commits.find((c) => c.sha === sha);
    const shortSha = sha.substring(0, 7);
    const confirmMessage = `Rollback to commit ${shortSha}?\n\n"${commit?.message.split("\n")[0] || "Unknown"}"\n\nThis will discard any unsaved changes.`;

    if (!window.confirm(confirmMessage)) return;

    setRollbackingSha(sha);

    try {
      const response = await fetch(
        `/api/v1/app-builder/sessions/${sessionId}/rollback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commitSha: sha }),
        },
      );

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success(`Rolled back to ${shortSha}`, {
          description: commit?.message.split("\n")[0],
        });
        onRollbackComplete?.();
        fetchCommits();
      } else {
        toast.error("Rollback failed", {
          description: data.error || "Unknown error",
        });
      }
    } catch (err) {
      toast.error("Rollback failed", {
        description: err instanceof Error ? err.message : "Connection error",
      });
    } finally {
      setRollbackingSha(null);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  };

  const formatFullDate = (dateString: string) => {
    return new Date(dateString).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  // Loading state
  if (loading) {
    return (
      <div className={cn("flex flex-col h-full bg-[#0a0a0b]", className)}>
        <div className="flex items-center justify-center h-full">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center gap-3"
          >
            <Loader2 className="h-7 w-7 animate-spin text-emerald-500/60" />
            <p className="text-sm text-white/50">Loading history...</p>
          </motion.div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className={cn("flex flex-col h-full bg-[#0a0a0b]", className)}>
        <div className="flex items-center justify-center h-full">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center gap-4 text-center px-6"
          >
            <AlertCircle className="h-8 w-8 text-red-400/70" />
            <div>
              <p className="text-sm text-white/70 font-medium mb-1">{error}</p>
              <p className="text-sm text-white/40">
                Check your connection and try again
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchCommits}
              className="mt-1 h-8 text-sm text-white/60 hover:text-white hover:bg-white/10"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </motion.div>
        </div>
      </div>
    );
  }

  // Empty state
  if (commits.length === 0) {
    return (
      <div className={cn("flex flex-col h-full bg-[#0a0a0b]", className)}>
        <div className="flex items-center justify-center h-full">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center gap-4 max-w-[280px] text-center px-6"
          >
            <History className="h-10 w-10 text-neutral-400" />
            <div>
              <p className="text-sm text-white/70 font-medium mb-1">
                No history yet
              </p>
              <p className="text-sm text-white/40 leading-relaxed">
                Save your work to create version checkpoints you can restore
                later
              </p>
            </div>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col h-full bg-[#0a0a0b]", className)}>
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-emerald-500/70" />
          <span className="text-sm font-medium text-white/70">
            {commits.length} version{commits.length !== 1 ? "s" : ""}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={fetchCommits}
          className="h-7 w-7 text-white/40 hover:text-white/70 hover:bg-white/5"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Commit list */}
      <ScrollArea className="flex-1">
        <div className="py-2">
          {commits.map((commit, index) => {
            const isFirst = index === 0;
            const isCurrent = currentCommitSha === commit.sha;
            const isRollingBack = rollbackingSha === commit.sha;
            const isExpanded = expandedCommit === commit.sha;

            return (
              <motion.div
                key={commit.sha}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: index * 0.03 }}
              >
                <Collapsible
                  open={isExpanded}
                  onOpenChange={(open) =>
                    setExpandedCommit(open ? commit.sha : null)
                  }
                >
                  <CollapsibleTrigger asChild>
                    <div
                      className={cn(
                        "group relative px-4 py-3 cursor-pointer transition-colors",
                        "border-l-2 border-transparent",
                        isExpanded && "bg-white/[0.04]",
                        isFirst && "border-l-emerald-500",
                        isCurrent && !isFirst && "border-l-emerald-500/50",
                        !isFirst && !isCurrent && "hover:bg-white/[0.03]",
                      )}
                    >
                      {/* Main row */}
                      <div className="flex items-start gap-3">
                        {/* Timeline dot */}
                        <div className="flex-shrink-0 mt-1.5">
                          {isFirst ? (
                            <Circle className="h-3 w-3 fill-emerald-500 text-emerald-500" />
                          ) : isCurrent ? (
                            <Check className="h-3 w-3 text-emerald-500" />
                          ) : (
                            <GitCommit className="h-3 w-3 text-white/25" />
                          )}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          {/* Message */}
                          <p
                            className={cn(
                              "text-sm leading-snug line-clamp-2 mb-1.5",
                              isFirst
                                ? "text-white/90 font-medium"
                                : "text-white/75",
                            )}
                          >
                            {commit.message.split("\n")[0]}
                          </p>

                          {/* Meta row */}
                          <div className="flex items-center flex-wrap gap-x-4 gap-y-1 text-xs text-white/40">
                            <span className="font-mono text-white/50">
                              {commit.sha.substring(0, 7)}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <Clock className="h-3 w-3" />
                              {formatDate(commit.date)}
                            </span>
                            {isFirst && (
                              <span className="text-emerald-400 font-medium">
                                Latest
                              </span>
                            )}
                            {isCurrent && !isFirst && (
                              <span className="text-emerald-400 font-medium">
                                Active
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Expand indicator */}
                        <motion.div
                          animate={{ rotate: isExpanded ? 90 : 0 }}
                          transition={{ duration: 0.15 }}
                          className="flex-shrink-0 mt-1"
                        >
                          <ChevronRight className="h-4 w-4 text-white/25" />
                        </motion.div>
                      </div>

                      {/* Quick rollback on hover */}
                      {!isFirst && !isCurrent && !isExpanded && (
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRollback(commit.sha);
                            }}
                            disabled={isRollingBack}
                            className="h-7 px-2.5 text-xs text-white/60 hover:text-white hover:bg-white/10"
                          >
                            {isRollingBack ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <>
                                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                                Restore
                              </>
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                  </CollapsibleTrigger>

                  {/* Expanded content */}
                  <CollapsibleContent asChild forceMount>
                    <AnimatePresence initial={false}>
                      {isExpanded && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          <div className="px-4 pb-4 pt-2 ml-6 border-l-2 border-white/[0.06]">
                            {/* Full SHA */}
                            <div className="mb-4 p-3 bg-black/30 rounded-xl">
                              <p className="text-xs text-white/40 mb-1.5 uppercase tracking-wide">
                                Commit SHA
                              </p>
                              <p className="text-sm font-mono text-white/60 select-all break-all">
                                {commit.sha}
                              </p>
                            </div>

                            {/* Author & Date */}
                            <div className="flex items-center gap-5 mb-4 text-sm text-white/50">
                              <span className="flex items-center gap-2">
                                <User className="h-4 w-4 text-white/30" />
                                {commit.author}
                              </span>
                              <span title={formatFullDate(commit.date)}>
                                {formatFullDate(commit.date)}
                              </span>
                            </div>

                            {/* Extended message */}
                            {commit.message.includes("\n") && (
                              <div className="mb-4 p-3 bg-black/30 rounded-xl">
                                <p className="text-xs text-white/40 mb-1.5 uppercase tracking-wide">
                                  Details
                                </p>
                                <p className="text-sm text-white/50 whitespace-pre-wrap font-mono leading-relaxed">
                                  {commit.message
                                    .split("\n")
                                    .slice(1)
                                    .join("\n")
                                    .trim()}
                                </p>
                              </div>
                            )}

                            {/* Actions */}
                            <div className="flex items-center justify-end pt-3 border-t border-white/[0.06]">
                              {isFirst ? (
                                <span className="text-sm text-emerald-400/70">
                                  This is the latest version
                                </span>
                              ) : isCurrent ? (
                                <span className="text-sm text-emerald-400/70">
                                  Currently active version
                                </span>
                              ) : (
                                <Button
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRollback(commit.sha);
                                  }}
                                  disabled={isRollingBack}
                                  className="h-8 px-4 text-sm bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                                >
                                  {isRollingBack ? (
                                    <>
                                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                      Restoring...
                                    </>
                                  ) : (
                                    <>
                                      <RotateCcw className="h-4 w-4 mr-2" />
                                      Restore This Version
                                    </>
                                  )}
                                </Button>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </CollapsibleContent>
                </Collapsible>
              </motion.div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
