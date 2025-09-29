import { useAgentRunDetail, useAgentRuns } from '@/hooks/use-query-hooks';
import { cn } from '@/lib/utils';
import type { UUID } from '@elizaos/core';
import {
  Activity,
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Eye,
  XCircle,
  Zap,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';

type AgentRunTimelineProps = {
  agentId: UUID;
};

type RunStatus = 'completed' | 'started' | 'timeout' | 'error';

interface TimelineEvent {
  id: string;
  type:
  | 'RUN_STARTED'
  | 'RUN_ENDED'
  | 'ACTION_STARTED'
  | 'ACTION_COMPLETED'
  | 'MODEL_USED'
  | 'EVALUATOR_COMPLETED'
  | 'EMBEDDING_EVENT';
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
  type: 'action' | 'attempt' | 'model' | 'evaluator' | 'embedding';
  status: 'completed' | 'failed' | 'running';
  startTime: number;
  duration?: number;
  icon: React.ComponentType<{ className?: string }>;
  attempts?: ProcessedEvent[];
  children?: ProcessedEvent[];
}

function formatDuration(durationMs?: number | null): string {
  if (!durationMs || durationMs < 0) return '—';
  if (durationMs < 1000) return `${durationMs.toFixed(2)}ms`;
  const seconds = (durationMs / 1000).toFixed(2);
  return `${seconds}s`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
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
    case 'attempt':
      return Clock;
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

// Removed page-level time scale to avoid confusing global durations across runs

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

    return runs.map((runSummary) => {
      // For now, create a processed run from the summary data
      // We'll only show detailed events for the selected run
      const isSelected = runSummary.runId === selectedRunId;
      const runDetail = isSelected ? runDetailQuery.data : null;

      let processedEvents: ProcessedEvent[] = [];

      if (runDetail && runDetail.events) {
        // Build grouped actions with attempts and nested events
        const orderedEvents: ProcessedEvent[] = [];
        const actionMap = new Map<string, ProcessedEvent>();
        const inFlightAttempt = new Map<string, ProcessedEvent>();

        const eventsSorted = [...runDetail.events].sort((a, b) => a.timestamp - b.timestamp);

        eventsSorted.forEach((event, index) => {
          switch (event.type) {
            case 'ACTION_STARTED': {
              const actionName =
                (event.data.actionName as string) ||
                (event.data.actionId as string) ||
                `Action ${index}`;
              const actionKey = (event.data.actionId as string) || actionName;

              let actionEvent = actionMap.get(actionKey);
              if (!actionEvent) {
                actionEvent = {
                  id: `action-${actionKey}`,
                  name: actionName,
                  type: 'action',
                  status: 'running',
                  startTime: event.timestamp,
                  icon: Activity,
                  attempts: [],
                };
                actionMap.set(actionKey, actionEvent);
                orderedEvents.push(actionEvent);
              } else {
                // For multiple attempts, keep earliest start
                actionEvent.startTime = Math.min(actionEvent.startTime, event.timestamp);
                actionEvent.status = 'running';
              }

              const attemptIndex = (actionEvent.attempts?.length || 0) + 1;
              const attemptEvent: ProcessedEvent = {
                id: `attempt-${actionKey}-${attemptIndex}`,
                name: `Attempt ${attemptIndex}`,
                type: 'attempt',
                status: 'running',
                startTime: event.timestamp,
                icon: Clock,
                attempts: [], // will hold nested child events like model calls
              };
              actionEvent.attempts = [...(actionEvent.attempts || []), attemptEvent];
              inFlightAttempt.set(actionKey, attemptEvent);
              break;
            }
            case 'ACTION_COMPLETED': {
              const actionName =
                (event.data.actionName as string) ||
                (event.data.actionId as string) ||
                `Action ${index}`;
              const actionKey = (event.data.actionId as string) || actionName;
              let actionEvent = actionMap.get(actionKey);
              if (!actionEvent) {
                // If we missed the start, create a placeholder action with a single attempt
                actionEvent = {
                  id: `action-${actionKey}`,
                  name: actionName,
                  type: 'action',
                  status: 'running',
                  startTime: event.timestamp,
                  icon: Activity,
                  attempts: [],
                };
                actionMap.set(actionKey, actionEvent);
                orderedEvents.push(actionEvent);
              }

              let attempt = inFlightAttempt.get(actionKey);
              if (!attempt) {
                // Missing start; synthesize an attempt starting at completion time
                attempt = {
                  id: `attempt-${actionKey}-1`,
                  name: 'Attempt 1',
                  type: 'attempt',
                  status: 'running',
                  startTime: event.timestamp,
                  icon: Clock,
                  attempts: [],
                };
                actionEvent.attempts = [...(actionEvent.attempts || []), attempt];
              }

              const success = (event.data.success as boolean | undefined) !== false;
              attempt.duration = Math.max(0, event.timestamp - attempt.startTime);
              attempt.status = success ? 'completed' : 'failed';
              inFlightAttempt.delete(actionKey);

              actionEvent.status = success ? 'completed' : 'failed';
              const firstAttemptStart = (actionEvent.attempts || [attempt])[0].startTime;
              actionEvent.duration = Math.max(0, event.timestamp - firstAttemptStart);
              break;
            }
            case 'MODEL_USED': {
              const modelType = (event.data.modelType as string) || 'Model Call';
              const modelEvent: ProcessedEvent = {
                id: `model-${index}`,
                name: modelType,
                type: 'model',
                status: 'completed',
                startTime: event.timestamp,
                duration: (event.data.executionTime as number) || undefined,
                icon: Eye,
              };
              const actionContext = (event.data.actionContext as string | undefined) || undefined;
              const targetKey = actionContext || Array.from(inFlightAttempt.keys()).pop();
              if (targetKey) {
                const attempt = inFlightAttempt.get(targetKey);
                if (attempt) {
                  attempt.attempts = [...(attempt.attempts || []), modelEvent];
                } else {
                  // If no running attempt, attach to the last attempt of the action
                  const actionEvent = actionMap.get(targetKey);
                  const lastAttempt = actionEvent?.attempts && actionEvent.attempts[actionEvent.attempts.length - 1];
                  if (lastAttempt) {
                    lastAttempt.attempts = [...(lastAttempt.attempts || []), modelEvent];
                  } else {
                    orderedEvents.push(modelEvent);
                  }
                }
              } else {
                orderedEvents.push(modelEvent);
              }
              break;
            }
            case 'EVALUATOR_COMPLETED': {
              const evaluatorName = (event.data.evaluatorName as string) || `Evaluator ${index}`;
              orderedEvents.push({
                id: `evaluator-${index}`,
                name: evaluatorName,
                type: 'evaluator',
                status: 'completed',
                startTime: event.timestamp,
                icon: Database,
              });
              break;
            }
            case 'EMBEDDING_EVENT': {
              const status = (event.data.status as string) || 'completed';
              const embeddingEvent: ProcessedEvent = {
                id: `embedding-${index}`,
                name: `Embedding ${status}`,
                type: 'embedding',
                status: status === 'failed' ? 'failed' : 'completed',
                startTime: event.timestamp,
                duration: (event.data.durationMs as number) || undefined,
                icon: Zap,
              };
              const key = Array.from(inFlightAttempt.keys()).pop();
              if (key) {
                const attempt = inFlightAttempt.get(key);
                if (attempt) {
                  attempt.attempts = [...(attempt.attempts || []), embeddingEvent];
                } else {
                  orderedEvents.push(embeddingEvent);
                }
              } else {
                orderedEvents.push(embeddingEvent);
              }
              break;
            }
            default:
              break;
          }
        });

        processedEvents = orderedEvents;
      }

      return {
        id: runSummary.runId,
        name: `Run ${formatTime(runSummary.startedAt || Date.now())}`,
        status: runSummary.status as RunStatus,
        startTime: runSummary.startedAt || Date.now(),
        endTime: runSummary.endedAt || undefined,
        duration:
          runSummary.durationMs ??
          (runSummary.endedAt != null && runSummary.startedAt != null
            ? runSummary.endedAt - runSummary.startedAt
            : undefined),
        children: processedEvents.sort((a, b) => a.startTime - b.startTime),
        counts: runSummary.counts || { actions: 0, modelCalls: 0, errors: 0, evaluators: 0 },
      };
    });
  }, [runs, runDetailQuery.data, selectedRunId]);

  // Helper function to calculate timeline bounds for a single run
  const calculateRunTimelineBounds = (run: ProcessedRun) => {
    let earliestStart = run.startTime;
    let latestEnd = run.endTime || run.startTime + (run.duration || 0);

    const scanEvent = (ev: ProcessedEvent) => {
      earliestStart = Math.min(earliestStart, ev.startTime);
      const end = ev.startTime + (ev.duration || 0);
      latestEnd = Math.max(latestEnd, end);
      (ev.attempts || []).forEach(scanEvent);
      (ev.children || []).forEach(scanEvent);
    };

    run.children.forEach(scanEvent);

    const totalDuration = latestEnd - earliestStart;

    // Ensure we have at least a minimal duration for visualization
    const minDuration = 100; // 100ms minimum for visualization

    return {
      startTime: earliestStart,
      endTime: latestEnd,
      totalDuration: Math.max(totalDuration, minDuration),
    };
  };

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
        {/* Intentionally no global time scale; each row shows its own proportional bar */}
      </div>

      {!isLoading && errorMessage && (
        <div className="px-4 py-8 text-sm text-red-500">Failed to load runs: {errorMessage}</div>
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
                timelineBounds={calculateRunTimelineBounds(run)}
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
  timelineBounds: {
    startTime: number;
    endTime: number;
    totalDuration: number;
  };
}

const RunItem: React.FC<RunItemProps> = ({
  run,
  isExpanded,
  onToggle,
  level,
  isSelected,
  timelineBounds,
}) => {
  const StatusIcon = getStatusIcon(run.status);
  const indent = level * 24;

  // Calculate timing bar parameters based on timeline bounds
  // For the run itself, we want the bar to span the full width since it represents the entire timeline
  const { startTime: timelineStart, totalDuration: timelineTotal } = timelineBounds;
  const runDuration = run.duration || 0;

  // For a run at the top level, the bar should show the full duration
  const isRootRun = level === 0;
  const startOffset = isRootRun ? 0 :
    (timelineTotal > 0 ? ((run.startTime - timelineStart) / timelineTotal) * 100 : 0);
  const widthPercent = isRootRun ? 100 :
    (timelineTotal > 0 ? (runDuration / timelineTotal) * 100 : 0);

  return (
    <div className="border-l-2 border-transparent">
      {/* Main run row */}
      <div
        className={cn(
          'flex items-center gap-3 p-3 cursor-pointer transition-colors',
          level > 0,
          isSelected && 'bg-primary/10 border-primary'
        )}
        style={{ paddingLeft: `${12 + indent}px` }}
        onClick={onToggle}
      >
        {/* Expand/collapse button */}
        <button className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
          {run.children.length > 0 &&
            (isExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            ))}
        </button>

        {/* Status icon */}
        <div
          className={cn(
            'flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs',
            getStatusColor(run.status)
          )}
        >
          <StatusIcon className="w-3 h-3" />
        </div>

        {/* Task name and details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{run.name}</span>
            <span
              className={cn(
                'px-1.5 py-0.5 text-xs rounded-full border',
                getStatusColor(run.status)
              )}
            >
              {run.status === 'completed' ? '✓' : run.status === 'error' ? '✗' : '○'}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {run.counts.actions} actions • {run.counts.modelCalls} model calls • {run.counts.errors}{' '}
            errors
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
              'absolute top-0 bottom-0 transition-all',
              run.status === 'completed'
                ? 'bg-blue-500 dark:bg-blue-600'
                : run.status === 'error'
                  ? 'bg-blue-700 dark:bg-blue-800'
                  : run.status === 'timeout'
                    ? 'bg-blue-400 dark:bg-blue-500'
                    : 'bg-blue-500 dark:bg-blue-600'
            )}
            style={{
              left: `${Math.max(0, Math.min(startOffset, 98))}%`,
              width: `${Math.max(2, Math.min(widthPercent, 100 - Math.max(0, Math.min(startOffset, 98))))}%`,
              borderRadius: 'inherit',
            }}
          />
        </div>
      </div>

      {/* Children */}
      {isExpanded && run.children.length > 0 && (
        <div className="border-l border-border ml-4">
          {run.children.map((child) => (
            <EventItem
              key={child.id}
              event={child}
              level={level + 1}
              timelineBounds={timelineBounds}
            />
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
  timelineBounds: {
    startTime: number;
    endTime: number;
    totalDuration: number;
  };
}

const EventItem: React.FC<EventItemProps> = ({ event, level, timelineBounds }) => {
  const IconComponent = event.icon;
  const StatusIcon = getStatusIcon(event.status);
  const indent = level * 24;
  const [expanded, setExpanded] = React.useState(true);
  const hasNested = (event.attempts && event.attempts.length > 0) || (event.children && event.children.length > 0);

  // Calculate timing bar parameters based on timeline bounds
  const { startTime: timelineStart, totalDuration: timelineTotal } = timelineBounds;
  const eventDuration = event.duration || 0;
  const startOffset =
    timelineTotal > 0 ? ((event.startTime - timelineStart) / timelineTotal) * 100 : 0;
  const widthPercent = timelineTotal > 0 ? (eventDuration / timelineTotal) * 100 : 0;

  return (
    <div>
      <div
        className="flex items-center gap-3 p-2 text-sm hover:bg-muted/30"
        style={{ paddingLeft: `${12 + indent}px` }}
      >
        {/* Expand/collapse if nested */}
        <button className="w-4 h-4 flex items-center justify-center" onClick={() => hasNested && setExpanded(!expanded)}>
          {hasNested ? (expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />) : null}
        </button>

        {/* Event icon */}
        <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
          <IconComponent className="w-3 h-3 text-muted-foreground" />
        </div>

        {/* Status icon */}
        <div
          className={cn(
            'flex-shrink-0 w-4 h-4 rounded-sm flex items-center justify-center text-xs',
            getStatusColor(event.status)
          )}
        >
          <StatusIcon className="w-2.5 h-2.5" />
        </div>

        {/* Event name */}
        <div className="flex-1 min-w-0">
          <span className="text-sm">{event.name}</span>
        </div>

        {/* Timing */}
        <div className="flex-shrink-0 text-right">
          <div className="text-xs font-mono text-muted-foreground">
            {formatDuration(event.duration)}
          </div>
        </div>

        {/* Mini timing bar */}
        <div className="flex-shrink-0 w-16 h-2 relative bg-muted rounded-sm overflow-hidden">
          <div
            className={cn(
              'absolute h-full transition-all',
              event.status === 'completed'
                ? 'bg-blue-400 dark:bg-blue-500'
                : event.status === 'failed'
                  ? 'bg-blue-600 dark:bg-blue-700'
                  : 'bg-blue-400 dark:bg-blue-500'
            )}
            style={{
              left: `${Math.max(0, Math.min(startOffset, 98))}%`,
              width: `${Math.max(1, Math.min(widthPercent, 100 - Math.max(0, Math.min(startOffset, 98))))}%`,
              borderRadius: 'inherit',
            }}
          />
        </div>
      </div>

      {/* Nested attempts or children */}
      {hasNested && expanded && (
        <div className="border-l border-border ml-4">
          {(event.attempts || []).map((child) => (
            <EventItem key={child.id} event={child} level={level + 1} timelineBounds={timelineBounds} />
          ))}
          {(event.children || []).map((child) => (
            <EventItem key={child.id} event={child} level={level + 1} timelineBounds={timelineBounds} />
          ))}
        </div>
      )}
    </div>
  );
};

export default AgentRunTimeline;
