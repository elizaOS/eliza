/**
 * Verifies safe sorting in curated coding memory candidates harvesting when lastActivityAt or timestamp contains NaN.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { harvestCodingMemoryCandidates } from "../../src/services/curated-coding-memory.js";
import type {
  OrchestratorTaskDocument,
  OrchestratorTaskMessage,
  OrchestratorTaskSession,
} from "../../src/services/orchestrator-task-types.js";

const ISO = "2026-08-23T00:00:00.000Z";

const mockRuntime: IAgentRuntime = {
  agentId: "agent-test",
  getSetting: () => undefined,
} as unknown as IAgentRuntime;

describe("curated-coding-memory safe sort", () => {
  it("safely harvests candidates without crashing when session lastActivityAt or message timestamp has NaN", () => {
    const doc: OrchestratorTaskDocument = {
      task: {
        id: "task-1",
        title: "Test",
        goal: "Test",
        kind: "task",
        status: "done",
        priority: "normal",
        originalRequest: "test",
        acceptanceCriteria: [],
        parentTaskId: undefined,
        paused: false,
        archived: false,
        createdAt: ISO,
        updatedAt: ISO,
        lastActivityAt: 100,
        metadata: {
          groundTruthVerdict: {
            status: "verified",
            pr: {
              exists: true,
              repo: "elizaOS/eliza",
              url: "https://github.com/elizaOS/eliza/pull/1",
              headSha: "abc1234",
            },
          },
        },
      },
      sessions: [
        {
          id: "sess-1",
          taskId: "task-1",
          sessionId: "s1",
          framework: "pi-agent",
          label: "Agent1",
          originalTask: "Test",
          workdir: "/path/to/repo",
          status: "completed",
          decisionCount: 0,
          autoResolvedCount: 0,
          registeredAt: 10,
          lastActivityAt: NaN,
          idleCheckCount: 0,
          taskDelivered: true,
          lastSeenDecisionIndex: 0,
          spawnedAt: 10,
          retryCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheTokens: 0,
          costUsd: 0,
          usageState: "unavailable",
          createdAt: ISO,
          updatedAt: ISO,
        } as OrchestratorTaskSession,
        {
          id: "sess-2",
          taskId: "task-1",
          sessionId: "s2",
          framework: "pi-agent",
          label: "Agent2",
          originalTask: "Test",
          workdir: "/path/to/repo2",
          status: "completed",
          decisionCount: 0,
          autoResolvedCount: 0,
          registeredAt: 10,
          lastActivityAt: 200,
          idleCheckCount: 0,
          taskDelivered: true,
          lastSeenDecisionIndex: 0,
          spawnedAt: 10,
          retryCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheTokens: 0,
          costUsd: 0,
          usageState: "unavailable",
          createdAt: ISO,
          updatedAt: ISO,
        } as OrchestratorTaskSession,
      ],
      events: [],
      messages: [
        {
          id: "msg-1",
          taskId: "task-1",
          sessionId: "s1",
          senderKind: "sub_agent",
          direction: "stdout",
          content: "Lesson: verified completion worked well",
          timestamp: NaN,
          createdAt: ISO,
        } as OrchestratorTaskMessage,
        {
          id: "msg-2",
          taskId: "task-1",
          sessionId: "s2",
          senderKind: "sub_agent",
          direction: "stdout",
          content: "Lesson: second verified completion",
          timestamp: 500,
          createdAt: ISO,
        } as OrchestratorTaskMessage,
      ],
      usage: [],
      artifacts: [],
      decisions: [],
      planRevisions: [],
    };

    const notes = harvestCodingMemoryCandidates(doc, mockRuntime);
    expect(Array.isArray(notes)).toBe(true);
  });
});
