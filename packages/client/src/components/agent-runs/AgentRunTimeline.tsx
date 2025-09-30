import { useAgentRuns } from '@/hooks/use-query-hooks';
import type { UUID } from '@elizaos/core';
import React, { useState } from 'react';
import { elizaSpanAdapter } from '@/lib/eliza-span-adapter';
import { Loader2, ChevronDown, ChevronRight, Clock, Zap, Activity, Database } from 'lucide-react';
import { useQueries } from '@tanstack/react-query';
import { createElizaClient } from '@/lib/api-client-config';
import type { RunDetail } from '@elizaos/api-client';
import type { TraceSpan } from '@evilmartians/agent-prism-types';
import { cn } from '@/lib/utils';

type AgentRunTimelineProps = {
  agentId: UUID;
};

const elizaClient = createElizaClient();

export const AgentRunTimeline: React.FC<AgentRunTimelineProps> = ({ agentId }) => {
  const [selectedRunId, setSelectedRunId] = useState<UUID | null>(null);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());

  const runsQuery = useAgentRuns(agentId);
  const runs = runsQuery.data?.runs ?? [];

  // Auto-select first run
  React.useEffect(() => {
    if (!selectedRunId && runs.length > 0) {
      setSelectedRunId(runs[0].runId);
    }
  }, [runs, selectedRunId]);

  // Fetch details for all runs using useQueries to avoid hook rule violations
  const runDetailQueries = useQueries({
    queries: runs.map((run) => ({
      queryKey: ['agent', agentId, 'runs', 'detail', run.runId, null],
      queryFn: async () => elizaClient.runs.getRun(agentId, run.runId),
      enabled: Boolean(agentId && run.runId),
      staleTime: 30000,
    })),
  });

  const selectedRunData = runs.find((r) => r.runId === selectedRunId);
  const selectedRunIndex = runs.findIndex((r) => r.runId === selectedRunId);
  const selectedRunDetail = selectedRunIndex >= 0 ? runDetailQueries[selectedRunIndex]?.data : null;

  const isLoading = runsQuery.isLoading;
  const errorMessage = runsQuery.error ? (runsQuery.error as Error).message : undefined;
  const hasRuns = runs.length > 0;

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

  const spans = selectedRunDetail
    ? elizaSpanAdapter.convertRunDetailToTraceSpans(selectedRunDetail as RunDetail)
    : [];

  return (
    <div className="flex flex-col h-full">
      {/* Run Selector */}
      <div className="px-4 py-3 border-b border-border space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Select Run</label>
        <select
          value={selectedRunId || ''}
          onChange={(e) => setSelectedRunId(e.target.value as UUID)}
          className="w-full px-3 py-2 text-sm bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {runs.map((run) => (
            <option key={run.runId} value={run.runId}>
              {new Date(run.startedAt || Date.now()).toLocaleString()} - {run.status}
            </option>
          ))}
        </select>
      </div>

      {/* Run Summary */}
      {selectedRunData && (
        <div className="px-4 py-3 border-b border-border bg-muted/30">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Status:</span>{' '}
              <span
                className={cn(
                  'font-medium',
                  selectedRunData.status === 'completed' && 'text-green-600 dark:text-green-400',
                  selectedRunData.status === 'error' && 'text-destructive',
                  selectedRunData.status === 'started' && 'text-blue-600 dark:text-blue-400'
                )}
              >
                {selectedRunData.status}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Duration:</span>{' '}
              <span className="font-medium">
                {selectedRunData.durationMs ? `${selectedRunData.durationMs}ms` : 'N/A'}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Actions:</span>{' '}
              <span className="font-medium">{selectedRunData.counts?.actions || 0}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Model Calls:</span>{' '}
              <span className="font-medium">{selectedRunData.counts?.modelCalls || 0}</span>
            </div>
          </div>
        </div>
      )}

      {/* Spans Tree */}
      <div className="flex-1 overflow-y-auto">
        {!selectedRunDetail && runDetailQueries[selectedRunIndex]?.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : spans.length === 0 ? (
          <div className="px-4 py-8 text-sm text-center text-muted-foreground">
            No trace data available for this run.
          </div>
        ) : (
          <div className="py-2">
            {spans.map((span) => (
              <SpanItem
                key={span.id}
                span={span}
                level={0}
                isExpanded={expandedSpans.has(span.id)}
                onToggle={() => toggleSpan(span.id)}
                expandedSpans={expandedSpans}
                onToggleChild={toggleSpan}
              />
            ))}
          </div>
        )}
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
}

const SpanItem: React.FC<SpanItemProps> = ({
  span,
  level,
  isExpanded,
  onToggle,
  expandedSpans,
  onToggleChild,
}) => {
  const hasChildren = span.children && span.children.length > 0;
  const indent = level * 12;

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
        return 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30';
      case 'error':
        return 'text-destructive bg-destructive/10';
      case 'warning':
        return 'text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-950/30';
      default:
        return 'text-muted-foreground bg-muted';
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
          'group flex items-start gap-2 px-3 py-2 hover:bg-accent/50 cursor-pointer transition-colors border-l-2',
          getStatusColor(),
          level === 0 && 'border-l-primary',
          level > 0 && 'border-l-muted'
        )}
        style={{ paddingLeft: `${12 + indent}px` }}
        onClick={onToggle}
      >
        {/* Expand/Collapse Icon */}
        <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center mt-0.5">
          {hasChildren ? (
            isExpanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )
          ) : null}
        </div>

        {/* Type Icon */}
        <div className={cn('flex-shrink-0 mt-0.5', getTypeColor())}>{getTypeIcon()}</div>

        {/* Content */}
        <div className="flex-1 min-w-0 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-foreground truncate">{span.title}</span>
            <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', getTypeColor())}>
              {span.type.replace('_', ' ').toUpperCase()}
            </span>
          </div>

          {/* Metadata */}
          <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
            {span.duration > 0 && (
              <span className="flex items-center gap-1">
                <Clock className="h-2.5 w-2.5" />
                {span.duration < 1000 ? `${span.duration.toFixed(0)}ms` : `${(span.duration / 1000).toFixed(2)}s`}
              </span>
            )}
            {span.tokensCount && (
              <span className="flex items-center gap-1">
                <Database className="h-2.5 w-2.5" />
                {span.tokensCount} tokens
              </span>
            )}
            {span.cost && (
              <span className="flex items-center gap-1">
                ${span.cost.toFixed(4)}
              </span>
            )}
          </div>

          {/* Input/Output Preview */}
          {(span.input || span.output) && isExpanded && (
            <div className="mt-2 space-y-1">
              {span.input && (
                <div className="p-2 bg-background/50 rounded border border-border">
                  <div className="text-[10px] font-medium text-muted-foreground mb-1">Input:</div>
                  <div className="text-[10px] text-foreground/80 line-clamp-3">{span.input}</div>
                </div>
              )}
              {span.output && (
                <div className="p-2 bg-background/50 rounded border border-border">
                  <div className="text-[10px] font-medium text-muted-foreground mb-1">Output:</div>
                  <div className="text-[10px] text-foreground/80 line-clamp-3">{span.output}</div>
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
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default AgentRunTimeline;