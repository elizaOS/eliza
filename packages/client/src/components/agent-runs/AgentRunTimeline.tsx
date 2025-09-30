import { useAgentRunDetail, useAgentRuns } from '@/hooks/use-query-hooks';
import type { UUID } from '@elizaos/core';
import React, { useMemo, useState } from 'react';
import { TraceViewer, type TraceViewerData } from '../agent-prism/TraceViewer';
import { elizaSpanAdapter } from '@/lib/eliza-span-adapter';
import { Loader2 } from 'lucide-react';

type AgentRunTimelineProps = {
  agentId: UUID;
};

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

  // Fetch details for all runs (we'll optimize this later with pagination)
  const runDetails = runs.map((run) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const detail = useAgentRunDetail(agentId, run.runId);
    return { run, detail };
  });

  // Convert ElizaOS runs to Agent Prism format
  const traceViewerData = useMemo((): TraceViewerData[] => {
    return runDetails
      .filter(({ detail }) => detail.data)
      .map(({ run, detail }) => ({
        traceRecord: elizaSpanAdapter.convertRunSummaryToTraceRecord(run),
        spans: detail.data ? elizaSpanAdapter.convertRunDetailToTraceSpans(detail.data) : [],
      }));
  }, [runDetails]);

  const isLoading = runsQuery.isLoading || runDetails.some(({ detail }) => detail.isLoading);
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