/**
 * Unit tests for trajectory row mapping, detail record shaping, ownership checks, and exports.
 */

import { describe, expect, it } from "vitest";
import {
  exportPersistedTrajectories,
  persistedTrajectoryToDetailRecord,
  trajectoryRowToListItem,
} from "./trajectory-export.js";
import type { PersistedTrajectory } from "./trajectory-internals.js";

describe("trajectory-export", () => {
  const agentId = "agent-123";
  const nowIso = new Date().toISOString();

  it("maps valid database row to TrajectoryListItem", () => {
    const row = {
      id: "traj-1",
      agent_id: agentId,
      source: "message_loop",
      status: "completed",
      start_time: 1000,
      end_time: 2500,
      duration_ms: 1500,
      total_reward: 1.0,
      steps_json: "[]",
      metrics_json: "{}",
      reward_components_json: "{}",
      step_count: 3,
      llm_call_count: 2,
      provider_access_count: 1,
      total_prompt_tokens: 150,
      total_completion_tokens: 50,
      total_cache_read_input_tokens: 0,
      total_cache_creation_input_tokens: 0,
      scenario_id: "scen-1",
      batch_id: "batch-1",
      created_at: nowIso,
      updated_at: nowIso,
      metadata: JSON.stringify({
        roomId: "room-1",
        entityId: "entity-1",
        conversationId: "conv-1",
      }),
    };

    const item = trajectoryRowToListItem(row, agentId);
    expect(item.id).toBe("traj-1");
    expect(item.agentId).toBe(agentId);
    expect(item.status).toBe("completed");
    expect(item.durationMs).toBe(1500);
    expect(item.stepCount).toBe(3);
    expect(item.llmCallCount).toBe(2);
    expect(item.roomId).toBe("room-1");
    expect(item.conversationId).toBe("conv-1");
  });

  it("throws ElizaError on ownership mismatch in row mapping", () => {
    const row = {
      id: "traj-2",
      agent_id: "other-agent",
      source: "message_loop",
      status: "completed",
      start_time: 1000,
      end_time: 2000,
      duration_ms: 1000,
      total_reward: 0,
      steps_json: "[]",
      metrics_json: "{}",
      reward_components_json: "{}",
      step_count: 1,
      llm_call_count: 1,
      provider_access_count: 0,
      total_prompt_tokens: 100,
      total_completion_tokens: 20,
      total_cache_read_input_tokens: 0,
      total_cache_creation_input_tokens: 0,
      created_at: nowIso,
      updated_at: nowIso,
      metadata: "{}",
    };

    expect(() => trajectoryRowToListItem(row, agentId)).toThrowError(
      /belongs to another agent/,
    );
  });

  it("converts persisted trajectory to detail record with step shaping and metrics", () => {
    const persisted: PersistedTrajectory = {
      id: "traj-3",
      agentId,
      source: "message_loop",
      status: "completed",
      startTime: 1000,
      endTime: 2000,
      steps: [
        {
          stepId: "step-1",
          stepIndex: 0,
          source: "user",
          type: "input",
          status: "completed",
          startTime: 1000,
          endTime: 1500,
          durationMs: 500,
          llmCalls: [
            {
              callId: "call-1",
              modelProvider: "anthropic",
              modelName: "claude-3-5-sonnet",
              callType: "generation",
              status: "completed",
              startTime: 1000,
              endTime: 1400,
              durationMs: 400,
              promptTokens: 100,
              completionTokens: 30,
              totalTokens: 130,
            },
          ],
          providerAccesses: [],
        },
      ],
      metrics: {
        stepCount: 1,
        llmCallCount: 1,
        providerAccessCount: 0,
        totalPromptTokens: 100,
        totalCompletionTokens: 30,
        totalCacheReadInputTokens: 0,
        totalCacheCreationInputTokens: 0,
      },
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    };

    const detail = persistedTrajectoryToDetailRecord(persisted, agentId);
    expect(detail.trajectoryId).toBe("traj-3");
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0].llmCalls[0].trajectoryId).toBe("traj-3");
    expect(detail.metrics.episodeLength).toBe(1);
    expect(detail.metrics.finalStatus).toBe("completed");
  });

  it("exports persisted trajectories with serializeTrajectoryExport", () => {
    const persisted: PersistedTrajectory = {
      id: "traj-4",
      agentId,
      source: "message_loop",
      status: "completed",
      startTime: 1000,
      endTime: 2000,
      steps: [],
      metrics: {
        stepCount: 0,
        llmCallCount: 0,
        providerAccessCount: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCacheReadInputTokens: 0,
        totalCacheCreationInputTokens: 0,
      },
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    };

    const result = exportPersistedTrajectories({
      agentId,
      persistedTrajectories: [persisted],
      options: { format: "json" },
    });

    expect(result.data).toBeDefined();
    expect(result.mimeType).toBe("application/json");
  });
});
