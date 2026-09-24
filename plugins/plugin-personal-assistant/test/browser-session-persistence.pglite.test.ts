/**
 * Exercises retained stored-session claims and checkpoints against the real PGlite
 * repository so concurrent workers cannot share or rewind durable sessions.
 */
import type { AgentRuntime } from "@elizaos/core";
import type { BrowserBridgeCompanionStatus } from "@elizaos/plugin-browser";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LifeOpsBrowserSession } from "../src/contracts/index.js";
import {
  createLifeOpsBrowserSession,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

let runtimeResult: RealTestRuntimeResult | null = null;
let runtime: AgentRuntime;
let repository: LifeOpsRepository;

function companion(
  id: string,
  profileId: string,
): BrowserBridgeCompanionStatus {
  const now = new Date().toISOString();
  return {
    id,
    agentId: runtime.agentId,
    browser: "chrome",
    profileId,
    profileLabel: profileId,
    label: id,
    extensionVersion: "test",
    connectionState: "connected",
    permissions: {
      tabs: true,
      scripting: true,
      activeTab: true,
      allOrigins: false,
      grantedOrigins: [],
      incognitoEnabled: false,
    },
    lastSeenAt: now,
    pairedAt: now,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function queuedSession(): LifeOpsBrowserSession {
  return createLifeOpsBrowserSession({
    agentId: runtime.agentId,
    domain: "browser",
    subjectType: "owner",
    subjectId: "owner",
    visibilityScope: "owner",
    contextPolicy: "owner_private",
    workflowId: null,
    browser: "chrome",
    companionId: null,
    profileId: null,
    windowId: null,
    tabId: null,
    title: "atomic companion session",
    status: "queued",
    actions: [0, 1].map((index) => ({
      id: `action-${index}`,
      kind: "read_page" as const,
      label: `Read ${index}`,
      url: null,
      selector: null,
      text: null,
      accountAffecting: false,
      requiresConfirmation: false,
      metadata: {},
    })),
    currentActionIndex: 0,
    awaitingConfirmationForActionId: null,
    result: {},
    metadata: {},
    finishedAt: null,
  });
}

beforeAll(async () => {
  runtimeResult = await createLifeOpsTestRuntime();
  runtime = runtimeResult.runtime;
  repository = new LifeOpsRepository(runtime);
}, 180_000);

afterEach(async () => {
  for (const session of await repository.listBrowserSessions(runtime.agentId)) {
    await repository.deleteBrowserSession(runtime.agentId, session.id);
  }
});

afterAll(async () => {
  await runtimeResult?.cleanup();
  runtimeResult = null;
});

describe("stored browser session atomic persistence", () => {
  it("accepts the terminal checkpoint idempotently and rejects rewinds or foreign updates", async () => {
    const session = queuedSession();
    await repository.createBrowserSession(session);
    const owner = companion("companion-progress-owner", "profile-owner");
    const foreign = companion("companion-progress-foreign", "profile-foreign");
    const claimed = await repository.claimBrowserSession(
      runtime.agentId,
      owner,
      new Date().toISOString(),
    );
    expect(claimed?.id).toBe(session.id);

    const competingAttempts = await Promise.all(
      ["attempt-first-a", "attempt-first-b"].map((attemptId) =>
        repository.beginBrowserSessionActionFromCompanion({
          agentId: runtime.agentId,
          sessionId: session.id,
          companion: owner,
          currentActionIndex: 0,
          actionId: session.actions[0].id,
          attemptId,
          startedAt: new Date().toISOString(),
        }),
      ),
    );
    expect(competingAttempts.filter(Boolean)).toHaveLength(1);
    const firstAttemptId = competingAttempts[0]
      ? "attempt-first-a"
      : "attempt-first-b";
    const duplicateLease =
      await repository.beginBrowserSessionActionFromCompanion({
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: owner,
        currentActionIndex: 0,
        actionId: session.actions[0].id,
        attemptId: firstAttemptId,
        startedAt: new Date().toISOString(),
      });
    expect(duplicateLease).toBeNull();

    const mismatchedAction =
      await repository.updateBrowserSessionProgressFromCompanion({
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: owner,
        expectedActionIndex: 0,
        completedActionId: session.actions[1].id,
        attemptId: firstAttemptId,
        currentActionIndex: 1,
        resultPatch: { wrongAction: true },
        metadataPatch: {},
        updatedAt: new Date().toISOString(),
      });
    expect(mismatchedAction).toBeNull();

    const firstStep =
      await repository.updateBrowserSessionProgressFromCompanion({
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: owner,
        expectedActionIndex: 0,
        completedActionId: session.actions[0].id,
        attemptId: firstAttemptId,
        currentActionIndex: 1,
        resultPatch: { first: true },
        metadataPatch: {},
        updatedAt: new Date().toISOString(),
      });
    expect(firstStep?.currentActionIndex).toBe(1);

    const secondAttemptId = "attempt-second";
    await expect(
      repository.beginBrowserSessionActionFromCompanion({
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: owner,
        currentActionIndex: 1,
        actionId: session.actions[1].id,
        attemptId: secondAttemptId,
        startedAt: new Date().toISOString(),
      }),
    ).resolves.toMatchObject({ currentActionIndex: 1 });

    const terminal = await repository.updateBrowserSessionProgressFromCompanion(
      {
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: owner,
        expectedActionIndex: 1,
        completedActionId: session.actions[1].id,
        attemptId: secondAttemptId,
        currentActionIndex: session.actions.length,
        resultPatch: { terminal: true },
        metadataPatch: {},
        updatedAt: new Date().toISOString(),
      },
    );
    expect(terminal?.currentActionIndex).toBe(session.actions.length);

    const [retry, rewind, intrusion] = await Promise.all([
      repository.updateBrowserSessionProgressFromCompanion({
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: owner,
        expectedActionIndex: session.actions.length,
        completedActionId: session.actions[1].id,
        attemptId: secondAttemptId,
        currentActionIndex: session.actions.length,
        resultPatch: { retried: true },
        metadataPatch: {},
        updatedAt: new Date().toISOString(),
      }),
      repository.updateBrowserSessionProgressFromCompanion({
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: owner,
        expectedActionIndex: session.actions.length,
        completedActionId: session.actions[1].id,
        attemptId: secondAttemptId,
        currentActionIndex: 1,
        resultPatch: { rewound: true },
        metadataPatch: {},
        updatedAt: new Date().toISOString(),
      }),
      repository.updateBrowserSessionProgressFromCompanion({
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: foreign,
        expectedActionIndex: session.actions.length,
        completedActionId: session.actions[1].id,
        attemptId: secondAttemptId,
        currentActionIndex: session.actions.length,
        resultPatch: { stolen: true },
        metadataPatch: {},
        updatedAt: new Date().toISOString(),
      }),
    ]);
    expect(retry).toBeNull();
    expect(rewind).toBeNull();
    expect(intrusion).toBeNull();

    const foreignCompletion =
      await repository.completeBrowserSessionFromCompanion({
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: foreign,
        status: "done",
        expectedActionIndex: session.actions.length,
        completedActionId: session.actions[1].id,
        attemptId: secondAttemptId,
        resultPatch: { stolen: true },
        updatedAt: new Date().toISOString(),
      });
    expect(foreignCompletion).toBeNull();
  });

  it("atomically settles only one concurrent owner confirmation", async () => {
    const base = queuedSession();
    const expectedUpdatedAt = new Date().toISOString();
    const awaiting: LifeOpsBrowserSession = {
      ...base,
      status: "awaiting_confirmation",
      awaitingConfirmationForActionId: base.actions[0].id,
      updatedAt: expectedUpdatedAt,
    };
    await repository.createBrowserSession(awaiting);

    const approved: LifeOpsBrowserSession = {
      ...awaiting,
      status: "queued",
      awaitingConfirmationForActionId: null,
      metadata: { browserApproval: { confirmedAt: new Date().toISOString() } },
      updatedAt: new Date(Date.now() + 1).toISOString(),
    };
    const denied: LifeOpsBrowserSession = {
      ...awaiting,
      status: "cancelled",
      awaitingConfirmationForActionId: null,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date(Date.now() + 2).toISOString(),
    };
    const results = await Promise.all(
      [approved, denied].map((candidate) =>
        repository.updateBrowserSessionIfAwaitingConfirmation({
          session: candidate,
          expectedActionId: awaiting.actions[0].id,
          expectedUpdatedAt,
        }),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const persisted = await repository.getBrowserSession(
      runtime.agentId,
      awaiting.id,
    );
    expect(["queued", "cancelled"]).toContain(persisted?.status);
    if (persisted?.status === "queued") {
      await repository.updateBrowserSession({
        ...persisted,
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  });

  it("rejects a stale failed completion after its progress receipt committed", async () => {
    const session = queuedSession();
    await repository.createBrowserSession(session);
    const owner = companion("companion-complete-owner", "profile-complete");
    await repository.claimBrowserSession(
      runtime.agentId,
      owner,
      new Date().toISOString(),
    );
    const firstAction = session.actions[0];
    const attemptId = "attempt-before-lost-progress-response";
    await repository.beginBrowserSessionActionFromCompanion({
      agentId: runtime.agentId,
      sessionId: session.id,
      companion: owner,
      currentActionIndex: 0,
      actionId: firstAction.id,
      attemptId,
      startedAt: new Date().toISOString(),
    });
    const progressed =
      await repository.updateBrowserSessionProgressFromCompanion({
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: owner,
        expectedActionIndex: 0,
        completedActionId: firstAction.id,
        attemptId,
        currentActionIndex: 1,
        resultPatch: { first: true },
        metadataPatch: {
          browserActionReceipt: {
            actionId: firstAction.id,
            actionIndex: 0,
            attemptId,
          },
        },
        updatedAt: new Date().toISOString(),
      });
    expect(progressed?.currentActionIndex).toBe(1);

    const staleFailure = await repository.completeBrowserSessionFromCompanion({
      agentId: runtime.agentId,
      sessionId: session.id,
      companion: owner,
      status: "failed",
      expectedActionIndex: 0,
      completedActionId: firstAction.id,
      attemptId,
      resultPatch: { staleFailure: true },
      updatedAt: new Date().toISOString(),
    });
    expect(staleFailure).toBeNull();
    const persisted = await repository.getBrowserSession(
      runtime.agentId,
      session.id,
    );
    expect(persisted?.status).toBe("running");
    expect(persisted?.currentActionIndex).toBe(1);
  });
});
