import { useAgentRuns } from '@/hooks/use-query-hooks';
import type { UUID } from '@elizaos/core';
import React, { useMemo } from 'react';
import { elizaSpanAdapter } from '@/lib/eliza-span-adapter';
import { Loader2 } from 'lucide-react';
import { useQueries } from '@tanstack/react-query';
import { createElizaClient } from '@/lib/api-client-config';
import type { RunDetail } from '@elizaos/api-client';
import { TraceViewer, type TraceViewerData } from '../agent-prism/TraceViewer';

type AgentRunTimelineProps = {
  agentId: UUID;
};

const elizaClient = createElizaClient();

export const AgentRunTimeline: React.FC<AgentRunTimelineProps> = ({ agentId }) => {
  const runsQuery = useAgentRuns(agentId);
  const runs = runsQuery.data?.runs ?? [];

  // Fetch details for all runs using useQueries to avoid hook rule violations
  const runDetailQueries = useQueries({
    queries: runs.map((run) => ({
      queryKey: ['agent', agentId, 'runs', 'detail', run.runId, null],
      queryFn: async () => elizaClient.runs.getRun(agentId, run.runId),
      enabled: Boolean(agentId && run.runId),
      staleTime: 30000,
    })),
  });

  // Convert ElizaOS runs to Agent Prism format
  const traceViewerData: TraceViewerData[] = useMemo(() => {
    return runs
      .map((run, index) => {
        const detailQuery = runDetailQueries[index];
        if (!detailQuery?.data) return null;

        return {
          traceRecord: elizaSpanAdapter.convertRunSummaryToTraceRecord(run),
          spans: elizaSpanAdapter.convertRunDetailToTraceSpans(detailQuery.data as RunDetail),
        };
      })
      .filter((item): item is TraceViewerData => item !== null);
  }, [runs, ...runDetailQueries.map((q) => q.data)]);

  const isLoading = runsQuery.isLoading;
  const errorMessage = runsQuery.error ? (runsQuery.error as Error).message : undefined;
  const hasRuns = runs.length > 0;
  const hasData = traceViewerData.length > 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="px-4 py-3 text-sm text-destructive">Failed to load runs: {errorMessage}</div>
    );
  }

  if (!hasRuns) {
    return (
      <div className="px-4 py-8 text-sm text-center text-muted-foreground">
        No agent runs yet. Runs will appear here after the agent processes messages.
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading run details...</span>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <TraceViewer data={traceViewerData} />
    </div>
  );
};

export default AgentRunTimeline;
