import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../lib/args";

const tempDirs: string[] = [];
const createdAgents: string[] = [];

const closeDatabase = mock(async () => {});
const configureTrainingDependencies = mock(() => {});
const createAgent = mock(async () => {
  const id = `agent-${createdAgents.length + 1}`;
  createdAgents.push(id);
  return { id };
});
const deleteAgent = mock(async function (
  this: { serviceName?: string },
  _agentId: string,
  _managerId: string,
) {
  if (this?.serviceName !== "agent-service") {
    throw new Error("deleteAgent was called without the agent service context");
  }
});
const getRuntime = mock(async (agentId: string) => ({ agentId }));
const executeAutonomousTick = mock(
  async (agentId: string, _runtime: unknown, recordTrajectories?: boolean) => ({
    success: true,
    trajectoryId: recordTrajectories ? `traj-${agentId}` : undefined,
  }),
);
const dbWhere = mock(async () => [
  {
    trajectoryId: "traj-agent-1",
    agentId: "agent-1",
    archetype: "trader",
    stepsJson: JSON.stringify([
      { action: "BUY", input: "market", output: "trade" },
    ]),
    aiJudgeReward: 0.8,
    aiJudgeReasoning: "coherent",
    scenarioId: "feed-parallel",
    finalPnL: 12,
    metricsJson: JSON.stringify({ trades: 1 }),
  },
  {
    trajectoryId: "traj-agent-2",
    agentId: "agent-2",
    archetype: "trader",
    stepsJson: JSON.stringify([
      { action: "HOLD", input: "market", output: "wait" },
    ]),
    aiJudgeReward: 0.7,
    aiJudgeReasoning: "stable",
    scenarioId: "feed-parallel",
    finalPnL: 4,
    metricsJson: JSON.stringify({ trades: 0 }),
  },
]);
const dbFrom = mock(() => ({ where: dbWhere }));
const dbSelect = mock(() => ({ from: dbFrom }));

mock.module("@feed/db", () => ({
  actorState: {},
  aliasedTable: mock(() => ({})),
  and: (...args: unknown[]) => args,
  asSystem: () => ({}),
  asUser: () => ({}),
  chatParticipants: {},
  chats: {},
  closeDatabase,
  comments: {},
  db: {
    select: dbSelect,
    insert: mock(() => ({ values: mock(async () => undefined) })),
    transaction: mock(async () => undefined),
  },
  desc: (...args: unknown[]) => args,
  dmAcceptances: {},
  eq: (a: unknown, b: unknown) => ({ a, b }),
  follows: {},
  groupMembers: {},
  groups: {},
  gte: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  messages: {},
  perpPositions: {},
  posts: {},
  reactions: {},
  shares: {},
  sql: {},
  trajectories: {
    trajectoryId: "trajectoryId",
    agentId: "agentId",
    archetype: "archetype",
    stepsJson: "stepsJson",
    aiJudgeReward: "aiJudgeReward",
    aiJudgeReasoning: "aiJudgeReasoning",
    scenarioId: "scenarioId",
    finalPnL: "finalPnL",
    metricsJson: "metricsJson",
  },
  users: {},
  withTransaction: mock(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({}),
  ),
}));

mock.module("@feed/agents/dependencies", () => ({
  configureTrainingDependencies,
  getAgentService: () => ({
    serviceName: "agent-service",
    createAgent,
    deleteAgent,
  }),
  getAgentRuntimeManager: () => ({ getRuntime }),
  getAutonomousCoordinator: () => ({ executeAutonomousTick }),
  getToTrainingMessages: () => () => [],
}));

mock.module("@feed/agents/rubrics/index", () => ({
  getAvailableArchetypes: () => ["trader"],
  getPriorityMetrics: () => [],
  getRubric: () => "rubric",
  hasCustomRubric: () => true,
}));

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "feed-parallel-generation-"));
  tempDirs.push(dir);
  return dir;
}

describe("feed train parallel generation", () => {
  afterEach(async () => {
    createdAgents.length = 0;
    configureTrainingDependencies.mockClear();
    createAgent.mockClear();
    deleteAgent.mockClear();
    getRuntime.mockClear();
    executeAutonomousTick.mockClear();
    dbSelect.mockClear();
    dbFrom.mockClear();
    dbWhere.mockClear();
    closeDatabase.mockClear();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  test("creates agents, records autonomous ticks, writes manifest, and cleans up", async () => {
    const outputDir = await makeTempDir();
    const { runParallelGeneration } = await import(
      "../commands/train-parallel.ts?live-generation"
    );

    await runParallelGeneration(
      parseArgs([
        "parallel",
        "--archetypes",
        "trader",
        "--num-agents",
        "2",
        "--ticks",
        "2",
        "--parallel",
        "2",
        "--manager-id",
        "manager-1",
        "--cleanup",
        "--output-dir",
        outputDir,
      ]),
    );

    expect(createAgent).toHaveBeenCalledTimes(2);
    const usernames = createAgent.mock.calls.map((call) => call[0]?.username);
    expect(new Set(usernames).size).toBe(2);
    expect(usernames.every((username) => (username?.length ?? 0) <= 20)).toBe(
      true,
    );
    expect(getRuntime).toHaveBeenCalledTimes(2);
    expect(executeAutonomousTick).toHaveBeenCalledTimes(4);
    expect(executeAutonomousTick.mock.calls[0]?.[2]).toBe(true);
    expect(deleteAgent).toHaveBeenCalledTimes(2);
    expect(closeDatabase).toHaveBeenCalledTimes(1);

    const manifestFiles = Array.from(
      new Bun.Glob("*.manifest.json").scanSync(outputDir),
    );
    expect(manifestFiles).toHaveLength(1);
    const manifest = JSON.parse(
      await readFile(join(outputDir, manifestFiles[0]!), "utf8"),
    );
    expect(manifest.schema).toBe("feed_parallel_generation");
    expect(manifest.counts).toMatchObject({
      agentsCreated: 2,
      trajectories: 2,
      totalTicks: 4,
      errors: 0,
    });
    expect(manifest.trajectoryIds).toEqual(["traj-agent-1", "traj-agent-2"]);
    expect(manifest.exportPath).toBe(
      join(outputDir, "feed-generated-trajectories.jsonl"),
    );
    const exported = (await readFile(manifest.exportPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(exported).toEqual([
      expect.objectContaining({
        trajectory_id: "traj-agent-1",
        agent_id: "agent-1",
        archetype: "trader",
        score: 0.8,
        scenario_id: "feed-parallel",
        steps: [expect.objectContaining({ action: "BUY" })],
      }),
      expect.objectContaining({
        trajectory_id: "traj-agent-2",
        agent_id: "agent-2",
        steps: [expect.objectContaining({ action: "HOLD" })],
      }),
    ]);
  });
});
