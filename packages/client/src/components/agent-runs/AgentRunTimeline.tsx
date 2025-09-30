import { useAgentRuns } from '@/hooks/use-query-hooks';
import type { UUID } from '@elizaos/core';
import React, { useMemo, useState } from 'react';
import { TraceViewer, type TraceViewerData } from '../agent-prism/TraceViewer';
import { elizaSpanAdapter } from '@/lib/eliza-span-adapter';
import { Loader2 } from 'lucide-react';
import { useQueries } from '@tanstack/react-query';
import { createElizaClient } from '@/lib/api-client-config';
import type { RunDetail } from '@elizaos/api-client';

type AgentRunTimelineProps = {
  agentId: UUID;
};

const elizaClient = createElizaClient();

export const AgentRunTimeline: React.FC<AgentRunTimelineProps> = ({ agentId }) => {
  const [selectedRunId, setSelectedRunId] = useState<UUID | null>(null);

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
      staleTime: 30000, // 30 seconds
    })),
  });

  // Convert ElizaOS runs to Agent Prism format - directly compute without unstable dependencies
  const traceViewerData: TraceViewerData[] = runs
    .map((run, index) => {
      const detailQuery = runDetailQueries[index];
      if (!detailQuery?.data) return null;

      return {
        traceRecord: elizaSpanAdapter.convertRunSummaryToTraceRecord(run),
        spans: elizaSpanAdapter.convertRunDetailToTraceSpans(detailQuery.data as RunDetail),
      };
    })
    .filter((item): item is TraceViewerData => item !== null);

  const isLoading = runsQuery.isLoading || runDetailQueries.some((q) => q.isLoading);
  const errorMessage = runsQuery.error ? (runsQuery.error as Error).message : undefined;
  const hasRuns = runs.length > 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="px-4 py-8 text-sm text-red-500">
        Failed to load runs: {errorMessage}
      </div>
    );
  }

  if (!hasRuns) {
    return (
      <div className="px-4 py-8 text-sm text-muted-foreground">
        No runs available yet.
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Agent Runs</h2>
        <p className="text-sm text-muted-foreground">
          Interactive timeline with LLM calls, actions, and tool executions.
        </p>
      </div>
      <TraceViewer data={traceViewerData} />
    </div>
  );
};

export default AgentRunTimeline;