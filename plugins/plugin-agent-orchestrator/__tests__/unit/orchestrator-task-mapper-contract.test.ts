/**
 * Contract test: the orchestrator route DTOs ({@link TaskThreadDetailDto} and
 * friends) and the `@elizaos/ui` client types (`CodingAgentTaskThreadDetail`
 * etc.) live in separate packages and agree only by convention over HTTP. This
 * test pins that agreement two ways:
 *
 *  1. Bidirectional type assignment between each server DTO and its client
 *     counterpart — compile-time enforcement that flows transitively into the
 *     nested record types, catching any divergent or removed required field.
 *  2. Runtime key-set comparison of a fully-mapped fixture against a
 *     client-typed reference — catches optional-field drift and any extra field
 *     the mapper emits (which structural assignment alone would permit).
 */

import type {
  CodingAgentOrchestratorStatus,
  CodingAgentTaskThread,
  CodingAgentTaskThreadDetail,
} from "@elizaos/ui";
import { describe, expect, it } from "vitest";
import type {
  TaskThreadDetailDto,
  TaskThreadDto,
} from "../../src/services/orchestrator-task-mapper.js";
import {
  summarizeUsage,
  toTaskThread,
  toTaskThreadDetail,
} from "../../src/services/orchestrator-task-mapper.js";
import type { OrchestratorTaskDocument } from "../../src/services/orchestrator-task-types.js";

const ISO = "2026-05-20T12:00:00.000Z";

/** A document with every optional field populated and one entry in each inline
 * collection, so the mapper emits every possible key for comparison. */
function fixtureDocument(): OrchestratorTaskDocument {
  return {
    task: {
      id: "task-1",
      title: "Ship the orchestrator view",
      goal: "Deliver a dense operator console",
      kind: "task",
      status: "active",
      priority: "high",
      originalRequest: "build the orchestrator",
      summary: "in progress",
      acceptanceCriteria: ["tests pass", "screenshots clean"],
      currentPlan: { summary: "do it", steps: ["a", "b"] },
      ownerUserId: "user-1",
      worldId: "world-1",
      roomId: "room-1",
      taskRoomId: "task-room-1",
      parentTaskId: "parent-1",
      forkSource: "parent-1",
      providerPolicy: {
        preferredFramework: "claude",
        providerSource: "user-claude",
        model: "claude-opus-4-7",
      },
      paused: false,
      archived: false,
      createdAt: ISO,
      updatedAt: ISO,
      closedAt: ISO,
      archivedAt: ISO,
      lastUserTurnAt: ISO,
      lastCoordinatorTurnAt: ISO,
      lastActivityAt: 1_716_206_400_000,
      metadata: { source: "test" },
    },
    sessions: [
      {
        id: "row-1",
        taskId: "task-1",
        sessionId: "session-1",
        framework: "claude",
        providerSource: "user-claude",
        model: "claude-opus-4-7",
        label: "worker",
        originalTask: "do the thing",
        goalPrompt: "wrapped goal",
        workdir: "/repo",
        repo: "owner/repo",
        status: "running",
        activeTool: "edit",
        decisionCount: 2,
        autoResolvedCount: 1,
        registeredAt: 1,
        lastActivityAt: 2,
        idleCheckCount: 0,
        taskDelivered: true,
        completionSummary: "done part",
        lastSeenDecisionIndex: 1,
        lastInputSentAt: 3,
        spawnedAt: 1,
        stoppedAt: 4,
        retryCount: 0,
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
        cacheTokens: 5,
        costUsd: 0.12,
        usageState: "measured",
        metadata: { k: "v" },
        createdAt: ISO,
        updatedAt: ISO,
      },
    ],
    events: [
      {
        id: "event-1",
        taskId: "task-1",
        sessionId: "session-1",
        eventType: "spawn",
        summary: "spawned worker",
        data: { detail: 1 },
        timestamp: 5,
        createdAt: ISO,
      },
    ],
    messages: [
      {
        id: "message-1",
        taskId: "task-1",
        sessionId: "session-1",
        roomId: "room-1",
        messageId: "m-1",
        senderKind: "sub_agent",
        direction: "stdout",
        content: "working on it",
        searchableText: "working on it",
        timestamp: 6,
        metadata: { stream: "stdout" },
        createdAt: ISO,
      },
    ],
    usage: [
      {
        id: "usage-1",
        taskId: "task-1",
        sessionId: "session-1",
        provider: "anthropic",
        model: "claude-opus-4-7",
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
        cacheTokens: 5,
        costUsd: 0.12,
        state: "measured",
        sourceEventId: "event-1",
        timestamp: 7,
        createdAt: ISO,
      },
    ],
    artifacts: [
      {
        id: "artifact-1",
        taskId: "task-1",
        sessionId: "session-1",
        artifactType: "pull_request",
        title: "PR #1",
        path: "/repo/file.ts",
        uri: "https://example.com/pr/1",
        mimeType: "text/plain",
        verificationStatus: "passed",
        metadata: { ci: "green" },
        createdAt: ISO,
      },
    ],
    decisions: [
      {
        id: "decision-1",
        taskId: "task-1",
        sessionId: "session-1",
        event: "permission",
        decisionType: "approve",
        actionSelected: "allow",
        promptText: "allow write?",
        promptExcerpt: "allow write?",
        response: "yes",
        reasoning: "safe edit",
        timestamp: 8,
        createdAt: ISO,
      },
    ],
  };
}

/** Reference values typed as the client contract. The annotations force these
 * literals to match the client types exactly; their runtime keys are the
 * reference the mapper output must reproduce. */
const clientThreadReference: CodingAgentTaskThread = {
  id: "task-1",
  title: "t",
  kind: "task",
  status: "active",
  priority: "high",
  paused: false,
  originalRequest: "r",
  summary: "s",
  sessionCount: 1,
  activeSessionCount: 1,
  latestSessionId: "session-1",
  latestSessionLabel: "worker",
  latestWorkdir: "/repo",
  latestRepo: "owner/repo",
  latestActivityAt: 1,
  decisionCount: 1,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    state: "measured",
    byProvider: [
      {
        provider: "anthropic",
        model: "claude-opus-4-7",
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        state: "measured",
      },
    ],
  },
  createdAt: ISO,
  updatedAt: ISO,
  closedAt: ISO,
  archivedAt: ISO,
};

const clientDetailReference: CodingAgentTaskThreadDetail = {
  ...clientThreadReference,
  goal: "g",
  roomId: "room-1",
  taskRoomId: "task-room-1",
  worldId: "world-1",
  ownerUserId: "user-1",
  parentTaskId: "parent-1",
  acceptanceCriteria: ["a"],
  currentPlan: { summary: "p" },
  providerPolicy: { preferredFramework: "claude" },
  lastUserTurnAt: ISO,
  lastCoordinatorTurnAt: ISO,
  metadata: {},
  sessions: [
    {
      id: "row-1",
      threadId: "task-1",
      sessionId: "session-1",
      framework: "claude",
      providerSource: "user-claude",
      model: "claude-opus-4-7",
      label: "worker",
      originalTask: "o",
      workdir: "/repo",
      repo: "owner/repo",
      status: "running",
      activeTool: "edit",
      decisionCount: 0,
      autoResolvedCount: 0,
      registeredAt: 1,
      lastActivityAt: 1,
      idleCheckCount: 0,
      taskDelivered: true,
      completionSummary: "c",
      lastSeenDecisionIndex: 0,
      lastInputSentAt: 1,
      stoppedAt: 1,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      usageState: "measured",
      metadata: {},
      createdAt: ISO,
      updatedAt: ISO,
    },
  ],
  decisions: [
    {
      id: "decision-1",
      threadId: "task-1",
      sessionId: "session-1",
      event: "permission",
      promptText: "p",
      decision: "allow",
      response: "yes",
      reasoning: "r",
      timestamp: 1,
      createdAt: ISO,
    },
  ],
  events: [
    {
      id: "event-1",
      threadId: "task-1",
      sessionId: "session-1",
      eventType: "spawn",
      timestamp: 1,
      summary: "s",
      data: {},
      createdAt: ISO,
    },
  ],
  artifacts: [
    {
      id: "artifact-1",
      threadId: "task-1",
      sessionId: "session-1",
      artifactType: "pull_request",
      title: "t",
      path: "/repo/file.ts",
      uri: "https://example.com",
      mimeType: "text/plain",
      verificationStatus: "passed",
      metadata: {},
      createdAt: ISO,
    },
  ],
  messages: [
    {
      id: "message-1",
      threadId: "task-1",
      sessionId: "session-1",
      senderKind: "sub_agent",
      direction: "stdout",
      content: "c",
      timestamp: 1,
      metadata: {},
      createdAt: ISO,
    },
  ],
  transcripts: [
    {
      id: "message-1",
      threadId: "task-1",
      sessionId: "session-1",
      timestamp: 1,
      direction: "stdout",
      content: "c",
      metadata: {},
      createdAt: ISO,
    },
  ],
};

function expectSameKeys(
  actual: object,
  reference: object,
  label: string,
): void {
  expect(Object.keys(actual).sort(), label).toEqual(
    Object.keys(reference).sort(),
  );
}

describe("orchestrator DTO ↔ client contract", () => {
  const detail = toTaskThreadDetail(fixtureDocument());
  const thread = toTaskThread(fixtureDocument());

  it("keeps the server DTOs structurally assignable to the client types", () => {
    // Compile-time enforcement (transitive through every nested record):
    const serverThreadIsClient: CodingAgentTaskThread = thread;
    const serverDetailIsClient: CodingAgentTaskThreadDetail = detail;
    const clientThreadIsServer: TaskThreadDto = clientThreadReference;
    const clientDetailIsServer: TaskThreadDetailDto = clientDetailReference;
    expect(serverThreadIsClient.id).toBe(thread.id);
    expect(serverDetailIsClient.id).toBe(detail.id);
    expect(clientThreadIsServer.id).toBe(clientThreadReference.id);
    expect(clientDetailIsServer.id).toBe(clientDetailReference.id);
  });

  it("reproduces the exact thread key set", () => {
    expectSameKeys(thread, clientThreadReference, "thread");
    expectSameKeys(thread.usage, clientThreadReference.usage, "thread.usage");
  });

  it("reproduces the exact detail key set", () => {
    expectSameKeys(detail, clientDetailReference, "detail");
  });

  it("reproduces the exact nested record key sets", () => {
    const session = detail.sessions[0];
    const decision = detail.decisions[0];
    const event = detail.events[0];
    const artifact = detail.artifacts[0];
    const message = detail.messages[0];
    const transcript = detail.transcripts[0];
    const provider = detail.usage.byProvider[0];
    if (
      !session ||
      !decision ||
      !event ||
      !artifact ||
      !message ||
      !transcript ||
      !provider
    ) {
      throw new Error("fixture must produce one of every nested record");
    }
    expectSameKeys(session, clientDetailReference.sessions[0], "session");
    expectSameKeys(decision, clientDetailReference.decisions[0], "decision");
    expectSameKeys(event, clientDetailReference.events[0], "event");
    expectSameKeys(artifact, clientDetailReference.artifacts[0], "artifact");
    expectSameKeys(message, clientDetailReference.messages[0], "message");
    expectSameKeys(
      transcript,
      clientDetailReference.transcripts[0],
      "transcript",
    );
    expectSameKeys(
      provider,
      clientThreadReference.usage.byProvider[0],
      "usage.byProvider",
    );
  });

  it("rolls up usage and exposes a state for the measured/estimated/unavailable UI split", () => {
    const usage = summarizeUsage(fixtureDocument());
    expect(usage.totalTokens).toBe(
      usage.inputTokens + usage.outputTokens + usage.reasoningTokens,
    );
    expect(usage.state).toBe("measured");
    expect(usage.byProvider).toHaveLength(1);
    // The summary type the route returns must satisfy the client status DTO's
    // usage field, so the workbench header renders without re-derivation.
    const status: Pick<CodingAgentOrchestratorStatus, "usage"> = { usage };
    expect(status.usage.byProvider[0]?.provider).toBe("anthropic");
  });
});
