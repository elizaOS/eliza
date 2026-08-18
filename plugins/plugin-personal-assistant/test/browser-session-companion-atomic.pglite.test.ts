/**
 * Exercises browser-companion claims and checkpoints against the real PGlite
 * repository so concurrent workers cannot share or rewind durable sessions.
 */
import type { AgentRuntime } from "@elizaos/core";
import type { BrowserBridgeCompanionStatus } from "@elizaos/plugin-browser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LifeOpsBrowserSession } from "../src/contracts/index.js";
import {
  BrowserDomain,
  type BrowserDomainDeps,
} from "../src/lifeops/domains/browser-service.js";
import type { LifeOpsContext } from "../src/lifeops/lifeops-context.js";
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

function browserDomain(): BrowserDomain {
  const context = {
    runtime,
    repository,
    agentId: () => runtime.agentId,
  } as unknown as LifeOpsContext;
  const deps = {
    recordBrowserAudit: async () => {},
  } as unknown as BrowserDomainDeps;
  return new BrowserDomain(context, deps);
}

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

afterAll(async () => {
  await runtimeResult?.cleanup();
  runtimeResult = null;
});

describe("browser companion atomic persistence", () => {
  it("allows exactly one competing companion to claim queued work", async () => {
    const session = queuedSession();
    await repository.createBrowserSession(session);
    const first = companion("companion-claim-a", "profile-a");
    const second = companion("companion-claim-b", "profile-b");
    const firstDomain = browserDomain();
    const secondDomain = browserDomain();

    const claims = await Promise.all([
      firstDomain.claimQueuedBrowserSession(first),
      secondDomain.claimQueuedBrowserSession(second),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const persisted = await repository.getBrowserSession(
      runtime.agentId,
      session.id,
    );
    expect(persisted?.status).toBe("running");
    expect(persisted?.companionId).toBe(claims.find(Boolean)?.companionId);
    expect(persisted?.profileId).toBe(claims.find(Boolean)?.profileId);
  });

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

    const firstStep =
      await repository.updateBrowserSessionProgressFromCompanion({
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: owner,
        expectedActionIndex: 0,
        currentActionIndex: 1,
        resultPatch: { first: true },
        metadataPatch: {},
        updatedAt: new Date().toISOString(),
      });
    expect(firstStep?.currentActionIndex).toBe(1);

    const terminal = await repository.updateBrowserSessionProgressFromCompanion(
      {
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: owner,
        expectedActionIndex: 1,
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
        resultPatch: { stolen: true },
        updatedAt: new Date().toISOString(),
      });
    expect(foreignCompletion).toBeNull();
  });

  it("settles competing terminal outcomes once", async () => {
    const session = queuedSession();
    await repository.createBrowserSession(session);
    const owner = companion("companion-complete-owner", "profile-complete");
    await repository.claimBrowserSession(
      runtime.agentId,
      owner,
      new Date().toISOString(),
    );

    const results = await Promise.all([
      repository.completeBrowserSessionFromCompanion({
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: owner,
        status: "done",
        resultPatch: { winner: "done" },
        updatedAt: new Date().toISOString(),
      }),
      repository.completeBrowserSessionFromCompanion({
        agentId: runtime.agentId,
        sessionId: session.id,
        companion: owner,
        status: "failed",
        resultPatch: { winner: "failed" },
        updatedAt: new Date().toISOString(),
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const persisted = await repository.getBrowserSession(
      runtime.agentId,
      session.id,
    );
    expect(["done", "failed"]).toContain(persisted?.status);
    expect(persisted?.currentActionIndex).toBe(session.actions.length);
  });
});
