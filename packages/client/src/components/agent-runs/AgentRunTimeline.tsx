import { useAgentRuns } from '@/hooks/use-query-hooks';
import type { UUID } from '@elizaos/core';
import React, { useState } from 'react';
import { elizaSpanAdapter } from '@/lib/eliza-span-adapter';
import { Loader2, ChevronDown, ChevronRight, Clock, Zap, Activity, Database, Circle } from 'lucide-react';
import { useQueries } from '@tanstack/react-query';
import { createElizaClient } from '@/lib/api-client-config';
import type { RunDetail } from '@elizaos/api-client';
import type { TraceSpan } from '@evilmartians/agent-prism-types';
import { DetailsView } from '../agent-prism/DetailsView/DetailsView';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

type AgentRunTimelineProps = {
  agentId: UUID;
};

const elizaClient = createElizaClient();

export const AgentRunTimeline: React.FC<AgentRunTimelineProps> = ({ agentId }) => {
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());
  const [selectedSpan, setSelectedSpan] = useState<TraceSpan | undefined>(undefined);

  const runsQuery = useAgentRuns(agentId);
  const runs = runsQuery.data?.runs ?? [];

  // Auto-expand first run
  React.useEffect(() => {
    if (runs.length > 0 && expandedRuns.size === 0) {
      setExpandedRuns(new Set([runs[0].runId]));
    }
  }, [runs, expandedRuns.size]);

  // Fetch details for all runs using useQueries
  const runDetailQueries = useQueries({
    queries: runs.map((run) => ({
      queryKey: ['agent', agentId, 'runs', 'detail', run.runId, null],
      queryFn: async () => elizaClient.runs.getRun(agentId, run.runId),
      enabled: Boolean(agentId && run.runId && expandedRuns.has(run.runId)),
      staleTime: 30000,
    })),
  });

  const isLoading = runsQuery.isLoading;
  const errorMessage = runsQuery.error ? (runsQuery.error as Error).message : undefined;
  const hasRuns = runs.length > 0;

  const toggleRun = (runId: string) => {
    const newExpanded = new Set(expandedRuns);
    if (newExpanded.has(runId)) {
      newExpanded.delete(runId);
    } else {
      newExpanded.add(runId);
    }
    setExpandedRuns(newExpanded);
  };

  const toggleSpan = (spanId: string) => {
    const newExpanded = new Set(expandedSpans);
    if (newExpanded.has(spanId)) {
      newExpanded.delete(spanId);
    } else {
      newExpanded.add(spanId);
    }
    setExpandedSpans(newExpanded);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="px-4 py-3 text-sm text-destructive">
        Failed to load runs: {errorMessage}
      </div>
    );
  }

  if (!hasRuns) {
    return (
      <div className="px-4 py-8 text-sm text-center text-muted-foreground">
        No agent runs yet. Runs will appear here after the agent processes messages.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Agent Runs Timeline</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{runs.length} runs</p>
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto">
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-8 top-0 bottom-0 w-px bg-border" />

          {/* Runs */}
          <div className="space-y-0">
            {runs.map((run, index) => {
              const isExpanded = expandedRuns.has(run.runId);
              const detailQuery = runDetailQueries[index];
              const spans = isExpanded && detailQuery?.data
                ? elizaSpanAdapter.convertRunDetailToTraceSpans(detailQuery.data as RunDetail)
                : [];

              return (
                <RunCard
                  key={run.runId}
                  run={run}
                  isExpanded={isExpanded}
                  onToggle={() => toggleRun(run.runId)}
                  isLoading={isExpanded && detailQuery?.isLoading}
                  spans={spans}
                  expandedSpans={expandedSpans}
                  onToggleSpan={toggleSpan}
                  onSelectSpan={setSelectedSpan}
                />
              );
            })}
          </div>
        </div>
      </div>
      {/* Modal details panel using app colors */}
      <Dialog open={Boolean(selectedSpan)} onOpenChange={(open) => !open && setSelectedSpan(undefined)}>
        <DialogContent className="max-w-3xl bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-foreground text-base">Span Details</DialogTitle>
          </DialogHeader>
          {selectedSpan && <DetailsView data={selectedSpan} />}
        </DialogContent>
      </Dialog>
    </div>
  );
};

interface RunCardProps {
  run: any;
  isExpanded: boolean;
  onToggle: () => void;
  isLoading?: boolean;
  spans: TraceSpan[];
  expandedSpans: Set<string>;
  onToggleSpan: (id: string) => void;
  onSelectSpan: (span: TraceSpan) => void;
}

const RunCard: React.FC<RunCardProps> = ({
  run,
  isExpanded,
  onToggle,
  isLoading,
  spans,
  expandedSpans,
  onToggleSpan,
  onSelectSpan,
}) => {
  const getStatusColor = () => {
    switch (run.status) {
      case 'completed':
        return 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800';
      case 'error':
        return 'text-destructive bg-destructive/10 border-destructive/20';
      case 'timeout':
        return 'text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-800';
      case 'started':
        return 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800';
      default:
        return 'text-muted-foreground bg-muted border-border';
    }
  };

  const getStatusIcon = () => {
    switch (run.status) {
      case 'completed':
        return <Circle className="h-3 w-3 fill-current" />;
      case 'error':
        return <Circle className="h-3 w-3 fill-current" />;
      case 'started':
        return <Loader2 className="h-3 w-3 animate-spin" />;
      default:
        return <Circle className="h-3 w-3" />;
    }
  };

  return (
    <div className="relative pl-4 pr-4 py-3">
      {/* Timeline dot */}
      <div className="absolute left-[1.875rem] top-5 z-10">
        <div className={cn('rounded-full p-1', getStatusColor())}>
          {getStatusIcon()}
        </div>
      </div>

      {/* Card */}
      <div className="ml-10">
        <div
          className={cn(
            'rounded-lg border bg-card cursor-pointer transition-all hover:shadow-sm',
            isExpanded && 'shadow-sm'
          )}
          onClick={onToggle}
        >
          {/* Run Header */}
          <div className="px-3 py-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-foreground">
                      {new Date(run.startedAt || Date.now()).toLocaleString()}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-2.5 w-2.5" />
                        {run.durationMs ? `${run.durationMs}ms` : 'N/A'}
                      </span>
                      <span>•</span>
                      <span>{run.counts?.actions || 0} actions</span>
                      <span>•</span>
                      <span>{run.counts?.modelCalls || 0} LLM</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className={cn('px-2 py-0.5 rounded-full text-[10px] font-medium border', getStatusColor())}>
                {run.status}
              </div>
            </div>
          </div>

          {/* Expanded Content */}
          {isExpanded && (
            <div className="border-t border-border" onClick={(e) => e.stopPropagation()}>
              {isLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : spans.length === 0 ? (
                <div className="px-3 py-4 text-xs text-center text-muted-foreground">
                  No trace data available
                </div>
              ) : (
                <div className="py-1">
                  {spans.map((span) => (
                    <SpanItem
                      key={span.id}
                      span={span}
                      level={0}
                      isExpanded={expandedSpans.has(span.id)}
                      onToggle={() => onToggleSpan(span.id)}
                      expandedSpans={expandedSpans}
                      onToggleChild={onToggleSpan}
                      onSelectSpan={onSelectSpan}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface SpanItemProps {
  span: TraceSpan;
  level: number;
  isExpanded: boolean;
  onToggle: () => void;
  expandedSpans: Set<string>;
  onToggleChild: (id: string) => void;
  onSelectSpan: (span: TraceSpan) => void;
}

const SpanItem: React.FC<SpanItemProps> = ({
  span,
  level,
  isExpanded,
  onToggle,
  expandedSpans,
  onToggleChild,
  onSelectSpan,
}) => {
  const hasChildren = span.children && span.children.length > 0;
  const indent = level * 16;

  const getTypeIcon = () => {
    switch (span.type) {
      case 'llm_call':
        return <Zap className="h-3 w-3" />;
      case 'agent_invocation':
        return <Activity className="h-3 w-3" />;
      case 'embedding':
        return <Database className="h-3 w-3" />;
      default:
        return <Clock className="h-3 w-3" />;
    }
  };

  const getStatusColor = () => {
    switch (span.status) {
      case 'success':
        return 'border-l-green-500 dark:border-l-green-400';
      case 'error':
        return 'border-l-destructive';
      case 'warning':
        return 'border-l-yellow-500 dark:border-l-yellow-400';
      default:
        return 'border-l-muted';
    }
  };

  const getTypeColor = () => {
    switch (span.type) {
      case 'llm_call':
        return 'text-purple-600 dark:text-purple-400';
      case 'agent_invocation':
        return 'text-blue-600 dark:text-blue-400';
      case 'embedding':
        return 'text-cyan-600 dark:text-cyan-400';
      case 'tool_execution':
        return 'text-orange-600 dark:text-orange-400';
      default:
        return 'text-muted-foreground';
    }
  };

  return (
    <div>
      <div
        className={cn(
          'group flex items-start gap-2 px-3 py-1.5 hover:bg-accent/30 cursor-pointer transition-colors border-l-2',
          getStatusColor()
        )}
        style={{ paddingLeft: `${12 + indent}px` }}
        onClick={() => onSelectSpan(span)}
      >
        {/* Expand/Collapse Icon */}
        <button
          type="button"
          className="flex-shrink-0 w-3 h-3 flex items-center justify-center mt-0.5"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          {hasChildren ? (
            isExpanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )
          ) : null}
        </button>

        {/* Type Icon */}
        <div className={cn('flex-shrink-0 mt-0.5', getTypeColor())}>{getTypeIcon()}</div>

        {/* Content */}
        <div className="flex-1 min-w-0 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground truncate">{span.title}</span>
            {span.type !== 'span' && (
              <span className={cn('text-[9px] opacity-70', getTypeColor())}>
                {span.type.replace('_', ' ').toUpperCase()}
              </span>
            )}
          </div>

          {/* Metadata */}
          {(span.duration > 0 || span.tokensCount || span.cost) && (
            <div className="flex items-center gap-2 mt-0.5 text-[9px] text-muted-foreground">
              {span.duration > 0 && (
                <span className="flex items-center gap-0.5">
                  <Clock className="h-2 w-2" />
                  {span.duration < 1000 ? `${span.duration.toFixed(0)}ms` : `${(span.duration / 1000).toFixed(2)}s`}
                </span>
              )}
              {span.tokensCount && (
                <>
                  <span>•</span>
                  <span>{span.tokensCount} tok</span>
                </>
              )}
              {span.cost && (
                <>
                  <span>•</span>
                  <span>${span.cost.toFixed(4)}</span>
                </>
              )}
            </div>
          )}

          {/* Input/Output Preview */}
          {(span.input || span.output) && isExpanded && (
            <div className="mt-1.5 space-y-1">
              {span.input && (
                <div className="p-1.5 bg-muted/30 rounded text-[9px]">
                  <div className="font-medium text-muted-foreground mb-0.5">Input:</div>
                  <div className="text-foreground/70 line-clamp-2">{span.input}</div>
                </div>
              )}
              {span.output && (
                <div className="p-1.5 bg-muted/30 rounded text-[9px]">
                  <div className="font-medium text-muted-foreground mb-0.5">Output:</div>
                  <div className="text-foreground/70 line-clamp-2">{span.output}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div>
          {span.children!.map((child) => (
            <SpanItem
              key={child.id}
              span={child}
              level={level + 1}
              isExpanded={expandedSpans.has(child.id)}
              onToggle={() => onToggleChild(child.id)}
              expandedSpans={expandedSpans}
              onToggleChild={onToggleChild}
              onSelectSpan={onSelectSpan}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default AgentRunTimeline;