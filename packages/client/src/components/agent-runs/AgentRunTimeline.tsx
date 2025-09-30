import { useAgentRuns } from '@/hooks/use-query-hooks';
import type { UUID } from '@elizaos/core';
import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { elizaSpanAdapter } from '@/lib/eliza-span-adapter';
import { Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { createElizaClient } from '@/lib/api-client-config';
import type { RunDetail } from '@elizaos/api-client';
import { TraceViewer, type TraceViewerData } from '../agent-prism/TraceViewer';
import type { TraceRecord, TraceSpan } from '@evilmartians/agent-prism-types';

type AgentRunTimelineProps = {
  agentId: UUID;
};

const elizaClient = createElizaClient();

// Number of recent runs to load details for immediately
const INITIAL_LOAD_COUNT = 10;

export const AgentRunTimeline: React.FC<AgentRunTimelineProps> = ({ agentId }) => {
  const runsQuery = useAgentRuns(agentId);
  const runs = runsQuery.data?.runs ?? [];

  // Cache to store loaded run details
  const [loadedRunDetails, setLoadedRunDetails] = useState<Map<string, TraceSpan[]>>(new Map());
  const [runsToLoad, setRunsToLoad] = useState<string[]>([]);

  // Initialize runs to load when runs data first arrives
  useEffect(() => {
    if (runs.length > 0 && runsToLoad.length === 0) {
      // Load details for the first N runs
      const initialRuns = runs.slice(0, INITIAL_LOAD_COUNT).map(r => r.runId);
      setRunsToLoad(initialRuns);
    }
  }, [runs, runsToLoad.length]);

  // Fetch details for runs in the loading queue
  const currentRunToLoad = runsToLoad[0];
  const currentRunDetailQuery = useQuery({
    queryKey: ['agent', agentId, 'runs', 'detail', currentRunToLoad ?? ''],
    queryFn: async () => {
      if (!currentRunToLoad) return null;
      return elizaClient.runs.getRun(agentId, currentRunToLoad as UUID);
    },
    enabled: Boolean(agentId && currentRunToLoad),
    staleTime: 30000,
  });

  // When a run detail finishes loading, add it to cache and move to next
  useEffect(() => {
    if (currentRunToLoad && currentRunDetailQuery.data && !currentRunDetailQuery.isLoading) {
      const spans = elizaSpanAdapter.convertRunDetailToTraceSpans(
        currentRunDetailQuery.data as RunDetail
      );

      setLoadedRunDetails((prev) => {
        const next = new Map(prev);
        next.set(currentRunToLoad, spans);
        return next;
      });

      // Remove the loaded run from queue
      setRunsToLoad((prev) => prev.slice(1));
    }
  }, [currentRunToLoad, currentRunDetailQuery.data, currentRunDetailQuery.isLoading]);

  // Convert ElizaOS runs to Agent Prism format with lazy-loaded spans
  const traceViewerData: TraceViewerData[] = useMemo(() => {
    return runs.map((run) => {
      const traceRecord = elizaSpanAdapter.convertRunSummaryToTraceRecord(run);
      const spans = loadedRunDetails.get(run.runId) ?? [];

      return {
        traceRecord,
        spans,
      };
    });
  }, [runs, loadedRunDetails]);

  // Callback to load a specific run's details on-demand
  const loadRunDetails = useCallback((runId: string) => {
    if (!loadedRunDetails.has(runId) && !runsToLoad.includes(runId)) {
      // Add to the front of the queue for priority loading
      setRunsToLoad((prev) => [runId, ...prev]);
    }
  }, [loadedRunDetails, runsToLoad]);

  // Create a wrapper component that intercepts trace selection
  const TraceViewerWithLazyLoading = useCallback(() => {
    // Wrap TraceViewer with selection interception
    const wrappedData = traceViewerData.map((item) => ({
      ...item,
      // Override the traceRecord to intercept when it's accessed/selected
      traceRecord: new Proxy(item.traceRecord, {
        get(target, prop) {
          // When a trace is accessed (likely being selected), trigger loading if needed
          if (prop === 'id' && typeof target.id === 'string') {
            const runId = runs.find(r =>
              elizaSpanAdapter.convertRunSummaryToTraceRecord(r).id === target.id
            )?.runId;
            if (runId && !loadedRunDetails.has(runId)) {
              // Trigger loading for this run
              loadRunDetails(runId);
            }
          }
          return target[prop as keyof TraceRecord];
        },
      }),
    }));

    return <TraceViewer data={wrappedData} />;
  }, [traceViewerData, runs, loadedRunDetails, loadRunDetails]);

  const isLoading = runsQuery.isLoading;
  const errorMessage = runsQuery.error ? (runsQuery.error as Error).message : undefined;
  const hasRuns = runs.length > 0;

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
    <div className="h-full w-full">
      <TraceViewerWithLazyLoading />
    </div>
  );
};

export default AgentRunTimeline;