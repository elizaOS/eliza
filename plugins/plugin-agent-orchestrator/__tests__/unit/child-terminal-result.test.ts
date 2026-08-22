/**
 * Verifies the typed child terminal-result envelope and task-detail projection.
 * Deterministic domain tests use durable documents only; no model or subprocess.
 */

import { describe, expect, it } from "vitest";
import { deriveChildTerminalResult } from "../../src/services/child-terminal-result.js";
import { toTaskThreadDetail } from "../../src/services/orchestrator-task-mapper.js";
import type {
  OrchestratorTaskDocument,
  OrchestratorTaskEvent,
  OrchestratorTaskStatus,
} from "../../src/services/orchestrator-task-types.js";

const ISO = "2026-08-22T00:00:00.000Z";

function documentFor(input: {
  status: OrchestratorTaskStatus;
  event: OrchestratorTaskEvent;
  artifacts?: OrchestratorTaskDocument["artifacts"];
}): OrchestratorTaskDocument {
  return {
    task: {
      id: "task-child",
      title: "Child work",
      goal: "Finish safely",
      kind: "task",
      status: input.status,
      priority: "normal",
      originalRequest: "delegate this",
      acceptanceCriteria: ["evidence is present"],
      parentTaskId: "task-parent",
      paused: false,
      archived: false,
      createdAt: ISO,
      updatedAt: ISO,
      lastActivityAt: 1,
      metadata: {},
    },
    sessions: [
      {
        id: "session-row",
        taskId: "task-child",
        sessionId: "session-child",
        framework: "pi-agent",
        label: "Ada",
        originalTask: "Finish safely",
        workdir: "/repo",
        status: "completed",
        decisionCount: 0,
        autoResolvedCount: 0,
        registeredAt: 1,
        lastActivityAt: 2,
        idleCheckCount: 0,
        taskDelivered: true,
        lastSeenDecisionIndex: 0,
        spawnedAt: 1,
        retryCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheTokens: 0,
        costUsd: 0,
        usageState: "unavailable",
        traceId: "trace-parent-child",
        parentTrajectoryStepId: "trajectory-step-parent",
        childTrajectoryIds: ["trajectory-child"],
        metadata: { parentSessionId: "session-parent" },
        createdAt: ISO,
        updatedAt: ISO,
      },
    ],
    events: [input.event],
    messages: [],
    usage: [],
    artifacts: input.artifacts ?? [],
    decisions: [],
    planRevisions: [],
  };
}

function event(
  eventType: string,
  data: Record<string, unknown>,
): OrchestratorTaskEvent {
  return {
    id: `event-${eventType}`,
    taskId: "task-child",
    sessionId: "session-child",
    eventType,
    summary: eventType,
    data,
    timestamp: 10,
    createdAt: ISO,
  };
}

describe("child terminal-result envelope", () => {
  it("surfaces a task-creator question as awaiting_user and redacts secrets", () => {
    const result = deriveChildTerminalResult(
      documentFor({
        status: "waiting_on_user",
        event: event("QUESTION_FOR_TASK_CREATOR", {
          question:
            "Which account should I use? OPENAI_API_KEY=sk-live-secret-value",
          deliveryStatus: "delivered",
        }),
      }),
    );

    expect(result).toMatchObject({
      status: "awaiting_user",
      requiresUserInput: true,
      deliveryStatus: "delivered",
    });
    expect(result?.question).toContain("Which account should I use?");
    expect(JSON.stringify(result)).not.toContain("sk-live-secret-value");
  });

  it("keeps an orchestrator-answerable coordination blocker off the user-question path", () => {
    const result = deriveChildTerminalResult(
      documentFor({
        status: "blocked",
        event: event("blocked", {
          routingKind: "AGENT_COORDINATION",
          message: "Need the orchestrator to inspect the sibling task output.",
          question: "Can the sibling result satisfy this dependency?",
        }),
      }),
    );

    expect(result).toMatchObject({
      status: "blocked",
      blocker: "Need the orchestrator to inspect the sibling task output.",
      requiresUserInput: false,
    });
    expect(result?.question).toBeUndefined();
  });

  it("requires evidence before a child completion is sufficient and projects it through the detail API", () => {
    const pendingDoc = documentFor({
      status: "validating",
      event: event("task_complete", { response: "Implemented the change." }),
    });
    const pending = toTaskThreadDetail(pendingDoc).childTerminalResult;
    expect(pending).toMatchObject({
      status: "completed",
      verificationStatus: "pending",
      deliveryStatus: "delivered",
      evidence: {
        required: true,
        present: false,
        sufficient: false,
        artifactRefs: [],
      },
      lineage: {
        taskId: "task-child",
        sessionId: "session-child",
        parentTaskId: "task-parent",
        parentSessionId: "session-parent",
        traceId: "trace-parent-child",
        parentTrajectoryStepId: "trajectory-step-parent",
        childTrajectoryIds: ["trajectory-child"],
      },
    });

    const passedDoc = documentFor({
      status: "done",
      event: event("task_complete", {
        response: "Implemented and verified the change.",
        evidence: "bun test: 12 passed",
      }),
      artifacts: [
        {
          id: "artifact-pr",
          taskId: "task-child",
          sessionId: "session-child",
          artifactType: "pull_request",
          title: "PR",
          uri: "https://example.test/pull/1",
          verificationStatus: "passed",
          metadata: {},
          createdAt: ISO,
        },
      ],
    });
    const passed = toTaskThreadDetail(passedDoc).childTerminalResult;
    expect(passed).toMatchObject({
      status: "completed",
      verificationStatus: "passed",
      evidence: {
        required: true,
        present: true,
        sufficient: true,
        artifactRefs: [
          {
            id: "artifact-pr",
            type: "pull_request",
            ref: "https://example.test/pull/1",
            verificationStatus: "passed",
          },
        ],
      },
    });
  });

  it("represents failed and cancelled children explicitly", () => {
    const failedDoc = documentFor({
      status: "failed",
      event: event("error", { message: "Worker process exited." }),
    });
    failedDoc.events.push({
      ...event("validation_failed", { reason: "Evidence did not verify." }),
      timestamp: 20,
    });
    const failed = deriveChildTerminalResult(failedDoc);
    expect(failed).toMatchObject({
      status: "failed",
      summary: "Worker process exited.",
      verificationStatus: "failed",
      requiresUserInput: false,
    });

    const cancelled = deriveChildTerminalResult(
      documentFor({
        status: "interrupted",
        event: event("stopped", { message: "Cancelled by parent." }),
      }),
    );
    expect(cancelled).toMatchObject({
      status: "cancelled",
      summary: "Cancelled by parent.",
      verificationStatus: "not_applicable",
      requiresUserInput: false,
    });
  });

  it("preserves an inconclusive verifier outcome as retryable evidence state", () => {
    const doc = documentFor({
      status: "waiting_on_user",
      event: event("task_complete", { response: "Work is ready for review." }),
    });
    doc.events.push({
      ...event("goal_verify_inconclusive", {
        reason: "Verifier model unavailable.",
      }),
      timestamp: 20,
    });

    expect(deriveChildTerminalResult(doc)).toMatchObject({
      status: "awaiting_user",
      verificationStatus: "inconclusive",
      evidence: { required: true, sufficient: false },
    });
  });

  it("derives redacted evidence and honest artifact states from a valid CompletionEnvelope", () => {
    const completion = {
      diffSummary:
        "Implemented child results in /private/tmp/internal/src/result.ts",
      filesChanged: [
        "/private/tmp/internal/src/result.ts",
        "src/unverified.ts",
      ],
      verifiedChangedFiles: [
        {
          path: "/private/tmp/internal/src/result.ts",
          exists: true,
          absolutePath: "/private/tmp/internal/src/result.ts",
        },
      ],
      missingArtifacts: ["/private/tmp/internal/screenshots/missing.png"],
      testResults: [
        {
          command: "bun test /private/tmp/internal/result.test.ts",
          exitCode: 0,
          summary: "Passed /private/tmp/internal/result.test.ts",
        },
      ],
      screenshotPaths: ["/private/tmp/internal/screenshots/missing.png"],
      trajectoryPath: "/private/tmp/internal/traces/trajectory.jsonl",
      acceptanceCriteriaStatus: [
        {
          criterion: "Result is projected",
          met: true,
          evidence: "Verified in /private/tmp/internal/src/result.ts",
        },
      ],
      residualRisks: [],
    };
    const result = deriveChildTerminalResult(
      documentFor({
        status: "done",
        event: event("task_complete", {
          response: `Finished.\n\`\`\`json\n${JSON.stringify(completion)}\n\`\`\``,
        }),
      }),
    );

    expect(result).toMatchObject({
      status: "completed",
      summary: "Implemented child results in result.ts",
      verificationStatus: "passed",
      evidence: {
        required: true,
        present: true,
        sufficient: true,
        artifactRefs: [
          {
            type: "verified_file",
            ref: "result.ts",
            verificationStatus: "passed",
          },
          {
            type: "claimed_file",
            ref: "src/unverified.ts",
            verificationStatus: "unknown",
          },
          {
            type: "screenshot",
            ref: "missing.png",
            verificationStatus: "failed",
          },
          {
            type: "trajectory",
            ref: "trajectory.jsonl",
            verificationStatus: "unknown",
          },
        ],
      },
    });
    expect(result?.evidence.summary).toContain("Tests 1/1 passed");
    expect(result?.evidence.summary).toContain("Criteria 1/1 met");
    expect(JSON.stringify(result)).not.toContain("/private/tmp/internal");
  });

  it("does not let late stopped or error events override verified completion", () => {
    const doc = documentFor({
      status: "done",
      event: event("task_complete", {
        response: JSON.stringify({
          diffSummary: "Completed and verified.",
          filesChanged: [],
          testResults: [],
          screenshotPaths: [],
          acceptanceCriteriaStatus: [],
          residualRisks: [],
        }),
      }),
    });
    doc.events.push(
      { ...event("error", { message: "late adapter error" }), timestamp: 20 },
      { ...event("stopped", { message: "late stop" }), timestamp: 30 },
      { ...event("validation_passed", {}), timestamp: 40 },
    );

    expect(deriveChildTerminalResult(doc)).toMatchObject({
      status: "completed",
      summary: "Completed and verified.",
      verificationStatus: "passed",
    });
  });
});
