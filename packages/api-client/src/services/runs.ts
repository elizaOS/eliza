import { UUID } from '@elizaos/core';
import { BaseApiClient } from '../lib/base-client';
import { ListRunsParams, RunDetail, RunSummary } from '../types/runs';

export class RunsService extends BaseApiClient {
  async listRuns(
    agentId: UUID,
    params?: ListRunsParams
  ): Promise<{ runs: RunSummary[]; total: number; hasMore: boolean }> {
    return this.get<{ runs: RunSummary[]; total: number; hasMore: boolean }>(
      `/api/agents/${agentId}/runs`,
      { params }
    );
  }

  async getRun(agentId: UUID, runId: UUID, roomId?: UUID): Promise<RunDetail> {
    return this.get<RunDetail>(`/api/agents/${agentId}/runs/${runId}`, {
      params: roomId ? { roomId } : undefined,
    });
  }
}
