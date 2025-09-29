import React, { useMemo, useState } from 'react';
import type { UUID } from '@elizaos/core';
import {
  useAgentRuns,
  useAgentRunDetail,
} from '@/hooks/use-query-hooks';
import type { RunSummary, RunEvent } from '@elizaos/api-client';
import { ChevronDown, ChevronRight, Clock, CheckCircle, XCircle, AlertCircle, Activity, Eye, Database, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

type AgentRunTimelineProps = {
  agentId: UUID;
};

type RunStatus = 'completed' | 'started' | 'timeout' | 'error';

interface TimelineEvent {
  id: string;
  type: 'RUN_STARTED' | 'RUN_ENDED' | 'ACTION_STARTED' | 'ACTION_COMPLETED' | 'MODEL_USED' | 'EVALUATOR_COMPLETED' | 'EMBEDDING_EVENT';
  timestamp: number;
  duration?: number;
  data: Record<string, unknown>;
  parentId?: string;
}

interface ProcessedRun {
  id: string;
  name: string;
  status: RunStatus;
  startTime: number;
  endTime?: number;
  duration?: number;
  children: ProcessedEvent[];
  counts: {
    actions: number;
    modelCalls: number;
    errors: number;
    evaluators: number;
  };
}

interface ProcessedEvent {
  id: string;
  name: string;
  type: 'action' | 'model' | 'evaluator' | 'embedding';
  status: 'completed' | 'failed' | 'running';
  startTime: number;
  duration?: number;
  icon: React.ComponentType<{ className?: string }>;
  attempts?: ProcessedEvent[];
}

function formatDuration(durationMs?: number | null): string {
  if (!durationMs || durationMs < 0) return '—';
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = (durationMs / 1000).toFixed(1);
  return `${seconds}s`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

function getStatusIcon(status: string) {
  switch (status) {
    case 'completed':
      return CheckCircle;
    case 'error':
    case 'failed':
      return XCircle;
    case 'timeout':
      return AlertCircle;
    case 'running':
    case 'started':
      return Clock;
    default:
      return Activity;
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'text-green-700 bg-green-100 border-green-300 dark:text-green-400 dark:bg-green-900/30 dark:border-green-800';
    case 'error':
    case 'failed':
      return 'text-red-700 bg-red-100 border-red-300 dark:text-red-400 dark:bg-red-900/30 dark:border-red-800';
    case 'timeout':
      return 'text-yellow-700 bg-yellow-100 border-yellow-300 dark:text-yellow-400 dark:bg-yellow-900/30 dark:border-yellow-800';
    case 'running':
    case 'started':
      return 'text-blue-700 bg-blue-100 border-blue-300 dark:text-blue-400 dark:bg-blue-900/30 dark:border-blue-800';
    default:
      return 'text-muted-foreground bg-muted border-border';
  }
}

function getEventIcon(type: string) {
  switch (type) {
    case 'action':
      return Activity;
    case 'model':
      return Eye;
    case 'evaluator':
      return Database;
    case 'embedding':
      return Zap;
    default:
      return Activity;
  }
}

export const AgentRunTimeline: React.FC<AgentRunTimelineProps> = ({ agentId }) => {
  const [selectedRunId, setSelectedRunId] = useState<UUID | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());

  const runsQuery = useAgentRuns(agentId);
  const runs = runsQuery.data?.runs ?? [];

  // Auto-select first run
  React.useEffect(() => {
    if (!selectedRunId && runs.length > 0) {
      setSelectedRunId(runs[0].runId);
    }
  }, [runs, selectedRunId]);

  const runDetailQuery = useAgentRunDetail(agentId, selectedRunId);

  const selectedRunSummary = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  );

  // Process run data into hierarchical structure
  const processedRuns = useMemo((): ProcessedRun[] => {
    if (runs.length === 0) {
      return [];
    }

    return runs.map(runSummary => {
      // For now, create a processed run from the summary data
      // We'll only show detailed events for the selected run
      const isSelected = runSummary.runId === selectedRunId;
      const runDetail = isSelected ? runDetailQuery.data : null;

      let processedEvents: ProcessedEvent[] = [];

      if (runDetail && runDetail.events) {
        runDetail.events.forEach((event, index) => {
          let processedEvent: ProcessedEvent | null = null;

          switch (event.type) {
            case 'ACTION_STARTED':
            case 'ACTION_COMPLETED': {
              const actionName = (event.data.actionName as string) || (event.data.actionId as string) || `Action ${index}`;
              processedEvent = {
                id: `action-${event.data.actionId || index}`,
                name: actionName,
                type: 'action',
                status: event.type === 'ACTION_COMPLETED' ? (event.data.success !== false ? 'completed' : 'failed') : 'running',
                startTime: event.timestamp,
                duration: event.data.executionTime as number,
                icon: Activity,
              };
              break;
            }
            case 'MODEL_USED': {
              const modelType = (event.data.modelType as string) || 'Model Call';
              processedEvent = {
                id: `model-${index}`,
                name: modelType,
                type: 'model',
                status: 'completed',
                startTime: event.timestamp,
                duration: event.data.executionTime as number,
                icon: Eye,
              };
              break;
            }
            case 'EVALUATOR_COMPLETED': {
              const evaluatorName = (event.data.evaluatorName as string) || `Evaluator ${index}`;
              processedEvent = {
                id: `evaluator-${index}`,
                name: evaluatorName,
                type: 'evaluator',
                status: 'completed',
                startTime: event.timestamp,
                icon: Database,
              };
              break;
            }
            case 'EMBEDDING_EVENT': {
              const status = (event.data.status as string) || 'completed';
              processedEvent = {
                id: `embedding-${index}`,
                name: `Embedding ${status}`,
                type: 'embedding',
                status: status === 'failed' ? 'failed' : 'completed',
                startTime: event.timestamp,
                duration: event.data.durationMs as number,
                icon: Zap,
              };
              break;
            }
          }

          if (processedEvent) {
            processedEvents.push(processedEvent);
          }
        });
      }

      return {
        id: runSummary.runId,
        name: `Run ${formatTime(runSummary.startedAt || Date.now())}`,
        status: runSummary.status as RunStatus,
        startTime: runSummary.startedAt || Date.now(),
        endTime: runSummary.endedAt || undefined,
        duration: runSummary.durationMs || (runSummary.endedAt && runSummary.startedAt ? runSummary.endedAt - runSummary.startedAt : undefined),
        children: processedEvents.sort((a, b) => a.startTime - b.startTime),
        counts: runSummary.counts || { actions: 0, modelCalls: 0, errors: 0, evaluators: 0 },
      };
    });
  }, [runs, runDetailQuery.data, selectedRunId]);

  // Toggle expansion of runs
  const toggleRunExpansion = (runId: string) => {
    const newExpanded = new Set(expandedRuns);
    if (newExpanded.has(runId)) {
      newExpanded.delete(runId);
    } else {
      newExpanded.add(runId);
    }
    setExpandedRuns(newExpanded);
  };

  const isLoading = runsQuery.isLoading || runDetailQuery.isLoading;
  const errorMessage = runsQuery.error ? (runsQuery.error as Error).message : undefined;
  const hasRuns = runs.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Agent Runs</h2>
          <p className="text-sm text-muted-foreground">
            Hierarchical view of agent execution with timing details.
          </p>
        </div>
        {hasRuns && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Errors only</span>
            <button className="w-6 h-6 rounded-full bg-muted flex items-center justify-center">
              ⚪
            </button>
          </div>
        )}
      </div>

      {isLoading && <div className="px-4 py-8 text-sm text-muted-foreground">Loading run data…</div>}
      {!isLoading && errorMessage && (
        <div className="px-4 py-8 text-sm text-red-500">
          Failed to load runs: {errorMessage}
        </div>
      )}
      {!isLoading && !errorMessage && !hasRuns && (
        <div className="px-4 py-8 text-sm text-muted-foreground">No runs available yet.</div>
      )}

      {processedRuns.length > 0 && (
        <div className="space-y-2">
          {processedRuns.map((run) => (
            <div key={run.id} className="bg-card rounded-lg border">
              <RunItem
                run={run}
                isExpanded={expandedRuns.has(run.id)}
                isSelected={selectedRunId === run.id}
                onToggle={() => {
                  toggleRunExpansion(run.id);
                  // Also set this as the selected run when expanded
                  if (!expandedRuns.has(run.id)) {
                    setSelectedRunId(run.id as UUID);
                  }
                }}
                level={0}
              />
            </div>
          ))}
        </div>
      )}

    </div>
  );
};

// RunItem component for hierarchical display
interface RunItemProps {
  run: ProcessedRun;
  isExpanded: boolean;
  onToggle: () => void;
  level: number;
  isSelected?: boolean;
}

const RunItem: React.FC<RunItemProps> = ({ run, isExpanded, onToggle, level, isSelected }) => {
  const StatusIcon = getStatusIcon(run.status);
  const indent = level * 24;

  // Calculate timing bar parameters
  const totalDuration = run.duration || 1000; // fallback for visualization
  const startOffset = 0;

  return (
    <div className="border-l-2 border-transparent">
      {/* Main run row */}
      <div
        className={cn(
          "flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer transition-colors",
          level > 0 && "border-l border-border ml-4",
          isSelected && "bg-primary/10 border-primary"
        )}
        style={{ paddingLeft: `${12 + indent}px` }}
        onClick={onToggle}
      >
        {/* Expand/collapse button */}
        <button className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
          {run.children.length > 0 && (
            isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />
          )}
        </button>

        {/* Status icon */}
        <div className={cn("flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs", getStatusColor(run.status))}>
          <StatusIcon className="w-3 h-3" />
        </div>

        {/* Task name and details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{run.name}</span>
            <span className={cn("px-1.5 py-0.5 text-xs rounded-full border", getStatusColor(run.status))}>
              {run.status === 'completed' ? '✓' : run.status === 'error' ? '✗' : '○'}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {run.counts.actions} actions • {run.counts.modelCalls} model calls • {run.counts.errors} errors
          </div>
        </div>

        {/* Timing information */}
        <div className="flex-shrink-0 text-right">
          <div className="text-xs text-muted-foreground">{formatTime(run.startTime)}</div>
          <div className="text-xs font-mono">{formatDuration(run.duration)}</div>
        </div>

        {/* Timing bar */}
        <div className="flex-shrink-0 w-32 h-6 relative bg-muted rounded-sm overflow-hidden">
          <div
            className={cn(
              "absolute top-0 bottom-0 rounded-sm transition-all",
              run.status === 'completed' ? "bg-green-500 dark:bg-green-600" :
                run.status === 'error' ? "bg-red-500 dark:bg-red-600" :
                  run.status === 'timeout' ? "bg-yellow-500 dark:bg-yellow-600" :
                    "bg-blue-500 dark:bg-blue-600"
            )}
            style={{
              left: `${startOffset}%`,
              width: `${Math.max(2, 100)}%`
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-white mix-blend-difference">
            {formatDuration(run.duration)}
          </div>
        </div>
      </div>

      {/* Children */}
      {isExpanded && run.children.length > 0 && (
        <div className="border-l border-border ml-4">
          {run.children.map((child) => (
            <EventItem key={child.id} event={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
};

// EventItem component for individual events
interface EventItemProps {
  event: ProcessedEvent;
  level: number;
}

const EventItem: React.FC<EventItemProps> = ({ event, level }) => {
  const IconComponent = event.icon;
  const StatusIcon = getStatusIcon(event.status);
  const indent = level * 24;

  return (
    <div
      className="flex items-center gap-3 p-2 text-sm hover:bg-muted/30"
      style={{ paddingLeft: `${12 + indent}px` }}
    >
      {/* Spacer for alignment */}
      <div className="w-4" />

      {/* Event icon */}
      <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
        <IconComponent className="w-3 h-3 text-muted-foreground" />
      </div>

      {/* Status icon */}
      <div className={cn("flex-shrink-0 w-4 h-4 rounded-sm flex items-center justify-center text-xs", getStatusColor(event.status))}>
        <StatusIcon className="w-2.5 h-2.5" />
      </div>

      {/* Event name */}
      <div className="flex-1 min-w-0">
        <span className="text-sm">{event.name}</span>
      </div>

      {/* Timing */}
      <div className="flex-shrink-0 text-right">
        <div className="text-xs font-mono text-muted-foreground">{formatDuration(event.duration)}</div>
      </div>

      {/* Mini timing bar */}
      <div className="flex-shrink-0 w-16 h-2 bg-muted rounded-sm overflow-hidden">
        <div
          className={cn(
            "h-full transition-all",
            event.status === 'completed' ? "bg-green-400 dark:bg-green-500" :
              event.status === 'failed' ? "bg-red-400 dark:bg-red-500" :
                "bg-blue-400 dark:bg-blue-500"
          )}
          style={{ width: '100%' }}
        />
      </div>
    </div>
  );
};

export default AgentRunTimeline;
