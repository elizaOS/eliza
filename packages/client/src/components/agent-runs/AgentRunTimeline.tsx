import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { UUID } from '@elizaos/core';
import {
  useAgentRuns,
  useAgentRunDetail,
} from '@/hooks/use-query-hooks';
import type { RunSummary } from '@elizaos/api-client';
import { Timeline, type TimelineOptions } from 'vis-timeline/standalone';
import 'vis-timeline/styles/vis-timeline-graph2d.min.css';

type AgentRunTimelineProps = {
  agentId: UUID;
  roomId?: UUID;
  limit?: number;
};

type TimelineItem = {
  id: string;
  content: string;
  start: Date;
  end?: Date;
  group?: string;
  type?: 'box' | 'point' | 'range';
  className?: string;
  title?: string;
};

type TimelineGroup = { id: string; content: string };

const RUN_GROUP_ID = 'run';
const ACTION_GROUP_ID = 'actions';
const MODEL_GROUP_ID = 'models';
const EVALUATOR_GROUP_ID = 'evaluators';
const EMBEDDING_GROUP_ID = 'embeddings';

const statusToClassName: Record<string, string> = {
  completed: 'timeline-item-success',
  started: 'timeline-item-neutral',
  timeout: 'timeline-item-warning',
  error: 'timeline-item-error',
};

const formatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'medium',
});

function formatDuration(durationMs?: number | null): string {
  if (!durationMs || durationMs < 0) return '—';
  const seconds = Math.floor((durationMs / 1000) % 60);
  const minutes = Math.floor((durationMs / (1000 * 60)) % 60);
  const hours = Math.floor(durationMs / (1000 * 60 * 60));
  const parts = [] as string[];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatRunLabel(run: RunSummary, index: number): string {
  const labelBase = run.metadata?.name ? String(run.metadata.name) : `Run ${index + 1}`;
  return `${labelBase}`;
}

const timelineOptions: TimelineOptions = {
  stack: true,
  maxHeight: 420,
  minHeight: 320,
  horizontalScroll: true,
  zoomKey: 'ctrlKey',
  showCurrentTime: true,
  margin: { item: 10, axis: 10 },
  groupHeightMode: 'fitItems',
  orientation: 'top',
};

export const AgentRunTimeline: React.FC<AgentRunTimelineProps> = ({
  agentId,
  roomId,
  limit = 20,
}) => {
  const [selectedRunId, setSelectedRunId] = useState<UUID | null>(null);
  const timelineContainerRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<Timeline | null>(null);

  const runsQuery = useAgentRuns(agentId, { roomId, limit });
  const runs = runsQuery.data?.runs ?? [];

  useEffect(() => {
    if (!selectedRunId && runs.length > 0) {
      setSelectedRunId(runs[0].runId);
    } else if (
      selectedRunId &&
      runs.length > 0 &&
      !runs.some((run) => run.runId === selectedRunId)
    ) {
      setSelectedRunId(runs[0].runId);
    }
  }, [runs, selectedRunId]);

  const runDetailQuery = useAgentRunDetail(agentId, selectedRunId, roomId);

  const selectedRunSummary = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  );

  const timelineData = useMemo(() => {
    if (!runDetailQuery.data) {
      return { items: [] as TimelineItem[], groups: [] as TimelineGroup[] };
    }

    const { summary, events } = runDetailQuery.data;
    const items: TimelineItem[] = [];
    const groups: TimelineGroup[] = [];

    if (summary.startedAt) {
      groups.push({ id: RUN_GROUP_ID, content: 'Run' });
      items.push({
        id: `run-${summary.runId}`,
        content: `Run (${summary.status})`,
        start: new Date(summary.startedAt),
        end: summary.endedAt ? new Date(summary.endedAt) : undefined,
        group: RUN_GROUP_ID,
        type: summary.endedAt ? 'range' : 'box',
        className: statusToClassName[summary.status] ?? 'timeline-item-neutral',
        title: `Started: ${formatter.format(new Date(summary.startedAt))}` +
          (summary.endedAt
            ? `\nEnded: ${formatter.format(new Date(summary.endedAt))}\nDuration: ${formatDuration(summary.durationMs)}`
            : ''),
      });
    }

    const actionItems = new Map<string, TimelineItem>();
    let hasActions = false;
    let hasModels = false;
    let hasEvaluators = false;
    let hasEmbeddings = false;

    events.forEach((event, index) => {
      const timestamp = new Date(event.timestamp);
      switch (event.type) {
        case 'ACTION_STARTED': {
          hasActions = true;
          const actionId = String(event.data.actionId ?? `action-${index}`);
          const actionName = (event.data.actionName as string | undefined) ?? 'Action started';
          const item: TimelineItem = {
            id: `action-start-${actionId}`,
            content: actionName,
            start: timestamp,
            group: ACTION_GROUP_ID,
            type: 'range',
            className: 'timeline-item-neutral',
            title: `Started: ${formatter.format(timestamp)}`,
          };
          actionItems.set(actionId, item);
          items.push(item);
          break;
        }
        case 'ACTION_COMPLETED': {
          hasActions = true;
          const actionId = String(event.data.actionId ?? `action-${index}`);
          const success = event.data.success !== false;
          const actionName = (event.data.actionName as string | undefined) ?? 'Action completed';
          const existing = actionItems.get(actionId);
          const itemTitleParts = [`Completed: ${formatter.format(timestamp)}`];
          if (typeof event.data.promptCount === 'number') {
            itemTitleParts.push(`Prompt calls: ${event.data.promptCount}`);
          }
          if (existing) {
            existing.end = timestamp;
            existing.className = success ? 'timeline-item-success' : 'timeline-item-error';
            existing.title = `${existing.title ?? ''}\n${itemTitleParts.join('\n')}`.trim();
          } else {
            items.push({
              id: `action-complete-${actionId}-${index}`,
              content: actionName,
              start: timestamp,
              group: ACTION_GROUP_ID,
              type: 'box',
              className: success ? 'timeline-item-success' : 'timeline-item-error',
              title: itemTitleParts.join('\n'),
            });
          }
          break;
        }
        case 'MODEL_USED': {
          hasModels = true;
          const modelType = (event.data.modelType as string | undefined) ?? 'Model call';
          items.push({
            id: `model-${index}`,
            content: modelType,
            start: timestamp,
            group: MODEL_GROUP_ID,
            type: 'box',
            className: 'timeline-item-neutral',
            title: `Provider: ${(event.data.provider as string | undefined) ?? 'Unknown'}\n` +
              (event.data.executionTime ? `Duration: ${formatDuration(Number(event.data.executionTime))}` : ''),
          });
          break;
        }
        case 'EVALUATOR_COMPLETED': {
          hasEvaluators = true;
          const evaluatorName = (event.data.evaluatorName as string | undefined) ?? 'Evaluator';
          items.push({
            id: `evaluator-${index}`,
            content: evaluatorName,
            start: timestamp,
            group: EVALUATOR_GROUP_ID,
            type: 'box',
            className: 'timeline-item-neutral',
            title: `Completed: ${formatter.format(timestamp)}`,
          });
          break;
        }
        case 'EMBEDDING_EVENT': {
          hasEmbeddings = true;
          const status = (event.data.status as string | undefined) ?? 'embedding';
          items.push({
            id: `embedding-${index}`,
            content: `Embedding ${status}`,
            start: timestamp,
            group: EMBEDDING_GROUP_ID,
            type: 'box',
            className:
              status === 'failed' ? 'timeline-item-error' : 'timeline-item-neutral',
            title: `Status: ${status}\n${formatter.format(timestamp)}`,
          });
          break;
        }
        default:
          break;
      }
    });

    if (hasActions) groups.push({ id: ACTION_GROUP_ID, content: 'Actions' });
    if (hasModels) groups.push({ id: MODEL_GROUP_ID, content: 'Model Calls' });
    if (hasEvaluators) groups.push({ id: EVALUATOR_GROUP_ID, content: 'Evaluators' });
    if (hasEmbeddings) groups.push({ id: EMBEDDING_GROUP_ID, content: 'Embeddings' });

    return { items, groups };
  }, [runDetailQuery.data]);

  useEffect(() => {
    if (!timelineContainerRef.current) return;
    if (!timelineRef.current) {
      timelineRef.current = new Timeline(
        timelineContainerRef.current,
        timelineData.items,
        timelineData.groups,
        timelineOptions
      );
    }

    return () => {
      timelineRef.current?.destroy();
      timelineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!timelineRef.current) return;

    timelineRef.current.setGroups(timelineData.groups);
    timelineRef.current.setItems(timelineData.items);

    const timestamps: number[] = [];
    timelineData.items.forEach((item) => {
      timestamps.push(item.start.getTime());
      if (item.end) timestamps.push(item.end.getTime());
    });
    if (timestamps.length > 0) {
      const min = Math.min(...timestamps);
      const max = Math.max(...timestamps);
      timelineRef.current.setWindow(new Date(min), new Date(max + 1000), {
        animation: false,
      });
    }
  }, [timelineData]);

  const isLoading = runsQuery.isLoading || runDetailQuery.isLoading;
  const hasRuns = runs.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Run Timeline</h2>
          <p className="text-sm text-muted-foreground">
            Visualize agent runs alongside actions and model activity.
          </p>
        </div>
        {hasRuns && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Run</span>
            <select
              className="rounded-md border bg-background px-3 py-1 text-sm"
              value={selectedRunId ?? ''}
              onChange={(event) => setSelectedRunId(event.target.value as UUID)}
            >
              {runs.map((run, index) => (
                <option key={run.runId} value={run.runId}>
                  {formatRunLabel(run, index)} — {run.status}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-2 text-sm font-medium">Timeline</div>
        <div className="relative px-2 py-4">
          {isLoading && <div className="px-4 py-8 text-sm text-muted-foreground">Loading run data…</div>}
          {!isLoading && !hasRuns && (
            <div className="px-4 py-8 text-sm text-muted-foreground">No runs available yet.</div>
          )}
          <div
            ref={timelineContainerRef}
            className="h-80 w-full"
            style={{ visibility: hasRuns ? 'visible' : 'hidden' }}
          />
        </div>
      </div>

      {selectedRunSummary && (
        <div className="rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold">
                {formatRunLabel(selectedRunSummary, runs.findIndex((r) => r.runId === selectedRunSummary.runId))}
              </h3>
              <p className="text-sm text-muted-foreground">ID: {selectedRunSummary.runId}</p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-sm font-medium ${
                selectedRunSummary.status === 'completed'
                  ? 'bg-emerald-100 text-emerald-700'
                  : selectedRunSummary.status === 'error'
                    ? 'bg-red-100 text-red-700'
                    : selectedRunSummary.status === 'timeout'
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-slate-100 text-slate-700'
              }`}
            >
              {selectedRunSummary.status}
            </span>
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Started</dt>
              <dd>{selectedRunSummary.startedAt ? formatter.format(new Date(selectedRunSummary.startedAt)) : '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Ended</dt>
              <dd>{selectedRunSummary.endedAt ? formatter.format(new Date(selectedRunSummary.endedAt)) : '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Duration</dt>
              <dd>{formatDuration(selectedRunSummary.durationMs)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Actions / Errors</dt>
              <dd>
                {selectedRunSummary.counts
                  ? `${selectedRunSummary.counts.actions} / ${selectedRunSummary.counts.errors}`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Model Calls</dt>
              <dd>{selectedRunSummary.counts ? selectedRunSummary.counts.modelCalls : '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Evaluators</dt>
              <dd>{selectedRunSummary.counts ? selectedRunSummary.counts.evaluators : '—'}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
};

export default AgentRunTimeline;
