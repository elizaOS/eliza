import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { AgentStatus, createTestAgent } from "@feed/agents";
import {
  AGENT_LOCK_DURATION_MS,
  acquireAgentLock,
  checkAgentLock,
  releaseAgentLock,
} from "@feed/agents/services/agent-lock-service";
import { agentRegistry } from "@feed/agents/services/agent-registry.service";
import { adminRoles, asSystem, db, inArray, userAgentConfigs } from "@feed/db";
import { generateSnowflakeId } from "@feed/shared";
import type {
  AgentTickResponse,
  AgentTickResultItem,
} from "../types/test-types";
import { waitForServerAvailability } from "./helpers";

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  "http://localhost:3000";

function getAgentLockId(agentId: string) {
  return `agent-tick-${agentId}`;
}

function getCronHeaders() {
  return {
    Authorization: `Bearer ${process.env.CRON_SECRET || "development"}`,
    "Content-Type": "application/json",
  };
}

function getTargetedTickUrl(agentId: string) {
  const url = new URL(`${BASE_URL}/api/cron/agent-tick`);
  url.searchParams.set("agentId", agentId);
  return url.toString();
}

async function clearGlobalAgentTickLock() {
  await db.generationLock.deleteMany({
    where: { id: "agent-tick-global" },
  });
}

async function deleteTestAgents(agentIds: string[]) {
  const ids = agentIds.filter(Boolean);
  if (ids.length === 0) {
    return;
  }

  await db.delete(adminRoles).where(inArray(adminRoles.userId, ids));
  await db
    .delete(userAgentConfigs)
    .where(inArray(userAgentConfigs.userId, ids));
  await db.user.deleteMany({
    where: { id: { in: ids } },
  });
}

describe("Agent Lock Service Integration", () => {
  let testAgentId1: string;
  let testAgentId2: string;

  beforeAll(async () => {
    const agent1 = await createTestAgent("lock-test-agent-1", {
      autonomousTrading: true,
      virtualBalance: 10000,
    });
    testAgentId1 = agent1.agentId;

    const agent2 = await createTestAgent("lock-test-agent-2", {
      autonomousTrading: true,
      virtualBalance: 10000,
    });
    testAgentId2 = agent2.agentId;
  });

  afterAll(async () => {
    await db.generationLock.deleteMany({
      where: {
        id: {
          in: [getAgentLockId(testAgentId1), getAgentLockId(testAgentId2)],
        },
      },
    });
    await deleteTestAgents([testAgentId1, testAgentId2]);
  });

  beforeEach(async () => {
    await db.generationLock.deleteMany({
      where: {
        id: {
          in: [getAgentLockId(testAgentId1), getAgentLockId(testAgentId2)],
        },
      },
    });
  });

  test("should acquire lock successfully when no lock exists", async () => {
    const processId = "test-process-1";
    const acquired = await acquireAgentLock(testAgentId1, processId);

    expect(acquired).toBe(true);

    const lock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });

    expect(lock).toBeTruthy();
    expect(lock?.lockedBy).toBe(processId);
    expect(lock?.operation).toBe("agent-tick");
    expect(lock?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await releaseAgentLock(testAgentId1, processId);
  });

  test("should prevent concurrent lock acquisition", async () => {
    const processId1 = "test-process-1";
    const processId2 = "test-process-2";

    expect(await acquireAgentLock(testAgentId1, processId1)).toBe(true);
    expect(await acquireAgentLock(testAgentId1, processId2)).toBe(false);

    const lock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    expect(lock?.lockedBy).toBe(processId1);

    await releaseAgentLock(testAgentId1, processId1);
  });

  test("should release lock properly", async () => {
    const processId = "test-process-release";

    await acquireAgentLock(testAgentId1, processId);
    await releaseAgentLock(testAgentId1, processId);

    expect(
      await db.generationLock.findUnique({
        where: { id: getAgentLockId(testAgentId1) },
      }),
    ).toBeNull();

    expect(await acquireAgentLock(testAgentId1, processId)).toBe(true);
    await releaseAgentLock(testAgentId1, processId);
  });

  test("should recover expired locks", async () => {
    await db.generationLock.create({
      data: {
        id: getAgentLockId(testAgentId1),
        lockedBy: "crashed-process",
        lockedAt: new Date(Date.now() - 20 * 60 * 1000),
        expiresAt: new Date(Date.now() - 5 * 60 * 1000),
        operation: "agent-tick",
      },
    });

    const processId = "recovery-process";
    expect(await acquireAgentLock(testAgentId1, processId)).toBe(true);

    const lock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    expect(lock?.lockedBy).toBe(processId);
    expect(lock?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await releaseAgentLock(testAgentId1, processId);
  });

  test("should keep locks independent per agent", async () => {
    const processId1 = "test-process-agent1";
    const processId2 = "test-process-agent2";

    expect(await acquireAgentLock(testAgentId1, processId1)).toBe(true);
    expect(await acquireAgentLock(testAgentId2, processId2)).toBe(true);

    const lock1 = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    const lock2 = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId2) },
    });

    expect(lock1?.lockedBy).toBe(processId1);
    expect(lock2?.lockedBy).toBe(processId2);

    await releaseAgentLock(testAgentId1, processId1);
    await releaseAgentLock(testAgentId2, processId2);
  });

  test("should handle race conditions gracefully", async () => {
    const processes = ["race-1", "race-2", "race-3", "race-4", "race-5"];
    const acquisitions = await Promise.all(
      processes.map((processId) => acquireAgentLock(testAgentId1, processId)),
    );

    expect(acquisitions.filter(Boolean)).toHaveLength(1);

    const lock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    expect(lock).toBeTruthy();
    expect(processes).toContain(lock?.lockedBy);

    await releaseAgentLock(testAgentId1, lock?.lockedBy);
  });

  test("should generate unique serverless-safe process IDs", async () => {
    expect(await acquireAgentLock(testAgentId1)).toBe(true);

    const firstLock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    expect(firstLock?.lockedBy).toMatch(/^serverless-\d+-[a-f0-9]{16}$/);

    await releaseAgentLock(testAgentId1, firstLock?.lockedBy);

    expect(await acquireAgentLock(testAgentId1)).toBe(true);

    const secondLock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    expect(secondLock?.lockedBy).toMatch(/^serverless-\d+-[a-f0-9]{16}$/);
    expect(secondLock?.lockedBy).not.toBe(firstLock?.lockedBy);

    await releaseAgentLock(testAgentId1, secondLock?.lockedBy);
  });

  test("should check lock status correctly", async () => {
    expect(await checkAgentLock(testAgentId1)).toBeNull();

    const processId = "check-test-process";
    await acquireAgentLock(testAgentId1, processId);

    const lockStatus = await checkAgentLock(testAgentId1);
    expect(lockStatus).toBeTruthy();
    expect(lockStatus?.id).toBe(getAgentLockId(testAgentId1));
    expect(lockStatus?.lockedBy).toBe(processId);
    expect(lockStatus?.operation).toBe("agent-tick");

    await releaseAgentLock(testAgentId1, processId);
    expect(await checkAgentLock(testAgentId1)).toBeNull();
  });

  test("should only allow the lock owner to release", async () => {
    const ownerProcess = "lock-owner";
    const intruderProcess = "intruder";

    await acquireAgentLock(testAgentId1, ownerProcess);
    await releaseAgentLock(testAgentId1, intruderProcess);

    const lock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    expect(lock?.lockedBy).toBe(ownerProcess);

    await releaseAgentLock(testAgentId1, ownerProcess);

    expect(
      await db.generationLock.findUnique({
        where: { id: getAgentLockId(testAgentId1) },
      }),
    ).toBeNull();
  });

  test("should set lock expiry timing correctly", async () => {
    await acquireAgentLock(testAgentId1, "expiry-test");

    const lock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    const expiryDuration = lock?.expiresAt.getTime() - Date.now();
    const buffer = 5000;

    expect(expiryDuration).toBeGreaterThan(AGENT_LOCK_DURATION_MS - buffer);
    expect(expiryDuration).toBeLessThan(AGENT_LOCK_DURATION_MS + buffer);

    await releaseAgentLock(testAgentId1, "expiry-test");
  });
});

describe("Agent Tick Endpoint Lock Integration", () => {
  let testAgentId: string;
  let createdGameId: string | null = null;
  let initialGameRunning: boolean | undefined;

  beforeAll(async () => {
    expect(await waitForServerAvailability(BASE_URL)).toBe(true);

    await clearGlobalAgentTickLock();

    const gameState = await asSystem(async (systemDb) => {
      return await systemDb.game.findFirst({
        where: { isContinuous: true },
      });
    });

    if (!gameState) {
      createdGameId = await generateSnowflakeId();
      await asSystem(async (systemDb) => {
        await systemDb.game.create({
          data: {
            id: createdGameId!,
            isContinuous: true,
            isRunning: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      });
    } else {
      initialGameRunning = gameState.isRunning;
      if (!gameState.isRunning) {
        await asSystem(async (systemDb) => {
          await systemDb.game.updateMany({
            where: { isContinuous: true },
            data: { isRunning: true },
          });
        });
      }
    }

    const agent = await createTestAgent("endpoint-lock-test", {
      autonomousTrading: true,
      virtualBalance: 10000,
    });
    testAgentId = agent.agentId;
    await agentRegistry.updateAgentStatus(testAgentId, AgentStatus.ACTIVE);

    let agentVisibleToServer = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(
        `${BASE_URL}/api/agents/${testAgentId}/card`,
      );
      agentVisibleToServer = response.status === 200;
      if (agentVisibleToServer) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(agentVisibleToServer).toBe(true);
  });

  afterAll(async () => {
    await clearGlobalAgentTickLock();
    await db.generationLock.deleteMany({
      where: { id: getAgentLockId(testAgentId) },
    });
    await deleteTestAgents([testAgentId]);

    if (createdGameId) {
      await db.game.deleteMany({
        where: { id: createdGameId },
      });
      return;
    }

    if (initialGameRunning === false) {
      await asSystem(async (systemDb) => {
        await systemDb.game.updateMany({
          where: { isContinuous: true },
          data: { isRunning: false },
        });
      });
    }
  });

  beforeEach(async () => {
    await clearGlobalAgentTickLock();
    await db.generationLock.deleteMany({
      where: { id: getAgentLockId(testAgentId) },
    });
  });

  test("skips a locked agent in the agent-tick endpoint", async () => {
    const manualProcess = "manual-lock-process";
    await acquireAgentLock(testAgentId, manualProcess);

    const response = await fetch(getTargetedTickUrl(testAgentId), {
      method: "POST",
      headers: getCronHeaders(),
      signal: AbortSignal.timeout(120_000),
    });

    expect(response.ok).toBe(true);

    const result = (await response.json()) as AgentTickResponse;
    expect(result.success).toBe(true);

    const agentResult = result.results?.find(
      (entry: AgentTickResultItem) => entry.agentId === testAgentId,
    );
    expect(agentResult).toBeDefined();
    expect(agentResult?.status).toBe("skipped");
    expect(agentResult?.reason).toBe("locked");
    expect(result.skippedLocked).toBeGreaterThanOrEqual(1);

    await releaseAgentLock(testAgentId, manualProcess);
  }, 120000);

  test("processes an unlocked agent through the endpoint", async () => {
    const response = await fetch(getTargetedTickUrl(testAgentId), {
      method: "POST",
      headers: getCronHeaders(),
      signal: AbortSignal.timeout(120_000),
    });

    expect(response.ok).toBe(true);

    const result = (await response.json()) as AgentTickResponse;
    expect(result.success).toBe(true);

    const agentResult = result.results?.find(
      (entry: AgentTickResultItem) => entry.agentId === testAgentId,
    );
    expect(agentResult).toBeDefined();
    expect(agentResult?.status).not.toBe("skipped");
    expect(agentResult?.reason).not.toBe("locked");

    expect(
      await db.generationLock.findUnique({
        where: { id: getAgentLockId(testAgentId) },
      }),
    ).toBeNull();
  }, 120000);
});
