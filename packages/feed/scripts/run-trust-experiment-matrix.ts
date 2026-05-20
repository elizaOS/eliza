#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { IAgentRuntime } from "@elizaos/core";
import { actors as staticActors } from "@feed/pack-default";
import { config as loadDotenv } from "dotenv";
import {
  buildTrustExperimentAgents,
  buildTrustExperimentManifest,
  type TrustExperimentAgentSpec,
  type TrustExperimentModelSize,
  writeTrustExperimentCharacterSheets,
} from "../packages/agents/src/character-roster/trust-experiment";

const FEED_REPO_ROOT = path.resolve(import.meta.dir, "..");
loadDotenv({ path: path.join(FEED_REPO_ROOT, ".env") });
loadDotenv({ path: path.join(FEED_REPO_ROOT, ".env.local") });

interface Options {
  agentCount: number;
  npcTargetCount: number;
  archetypeCount: number;
  modelSizes: TrustExperimentModelSize[];
  worldTicks: number;
  agentTicks: number;
  initialGroupChatsMin: number;
  initialGroupChatsMax: number;
  parallel: number;
  delayMs: number;
  outputDir: string;
  run: boolean;
  runtimeBaseUrl?: string;
  runtimeModel?: string;
  runtimeModelVersion?: string;
  seed: number;
  runId?: string;
}

interface AgentTickSummary {
  instanceId: string;
  username: string;
  success: boolean;
  trajectoryId?: string;
  error?: string;
}

interface RegisteredAgentSummary {
  instanceId: string;
  agentId: string;
  username: string;
  displayName: string;
  modelSize: string;
  trainingProfile: string;
  initialGroupChatTarget?: number;
  initialGroupChatCount?: number;
  initialGroupChatIds?: string[];
}

interface RunSummaryAggregate {
  successCount: number;
  failedCount: number;
  successRate: number | null;
  agentTickSuccessRate: number | null;
}

interface ExperimentTrajectoryContext {
  experimentRunId: string;
  roundNumber: number;
  totalRounds: number;
  seed: number;
}

interface InitialGroupChatSeedRecord {
  instanceId: string;
  agentId: string;
  username: string;
  displayName: string;
  targetGroupChatCount: number;
  assignedGroupChatCount: number;
  assignedChatIds: string[];
}

interface InitialGroupChatSeedingSummary {
  configuredRange: {
    min: number;
    max: number;
  };
  targetedAgentCount: number;
  zeroTargetAgentCount: number;
  requestedAssignments: number;
  assignedMembershipCount: number;
  agents: InitialGroupChatSeedRecord[];
}

type RuntimeCharacter = IAgentRuntime["character"] & {
  username?: string;
  lore?: string[];
  topics?: string[];
  adjectives?: string[];
  postExamples?: string[];
  messageExamples?: unknown;
  settings?: Record<string, string | number>;
};

type RuntimeWithSettings = IAgentRuntime & {
  settings?: Record<string, string>;
};

interface RunDeps {
  db: typeof import("@feed/db").db;
  and: typeof import("@feed/db").and;
  eq: typeof import("@feed/db").eq;
  inArray: typeof import("@feed/db").inArray;
  users: typeof import("@feed/db").users;
  chats: typeof import("@feed/db").chats;
  groups: typeof import("@feed/db").groups;
  groupMembers: typeof import("@feed/db").groupMembers;
  executeGameTick: typeof import("@feed/engine").executeGameTick;
  autoJoinEmptyUsersToNpcGroupChats: typeof import("@feed/engine").autoJoinEmptyUsersToNpcGroupChats;
  agentRuntimeManager: typeof import("@feed/agents").agentRuntimeManager;
  autonomousCoordinator: typeof import("@feed/agents").autonomousCoordinator;
  createTestAgent: typeof import("@feed/agents").createTestAgent;
  upsertAgentConfig: typeof import("../packages/agents/src/shared/agent-config").upsertAgentConfig;
}

let runDepsPromise: Promise<RunDeps> | null = null;

async function getRunDeps(): Promise<RunDeps> {
  if (!runDepsPromise) {
    runDepsPromise = (async () => {
      const [
        { and, chats, db, eq, groupMembers, groups, inArray, users },
        { autoJoinEmptyUsersToNpcGroupChats, executeGameTick },
        agents,
        sharedConfig,
      ] = await Promise.all([
        import("@feed/db"),
        import("@feed/engine"),
        import("@feed/agents"),
        import("../packages/agents/src/shared/agent-config"),
      ]);

      return {
        and,
        db,
        eq,
        inArray,
        users,
        chats,
        groups,
        groupMembers,
        executeGameTick,
        autoJoinEmptyUsersToNpcGroupChats,
        agentRuntimeManager: agents.agentRuntimeManager,
        autonomousCoordinator: agents.autonomousCoordinator,
        createTestAgent: agents.createTestAgent,
        upsertAgentConfig: sharedConfig.upsertAgentConfig,
      };
    })();
  }

  return runDepsPromise;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      agents: { type: "string", default: "100" },
      npcs: { type: "string", default: "150" },
      archetypes: { type: "string", default: "50" },
      "model-sizes": {
        type: "string",
        default: "0.5b,1.5b,3b,7b,14b,30b",
      },
      "world-ticks": { type: "string", default: "3" },
      "agent-ticks": { type: "string", default: "100" },
      "initial-group-chats-min": { type: "string", default: "0" },
      "initial-group-chats-max": { type: "string", default: "6" },
      parallel: { type: "string", default: "15" },
      delay: { type: "string", default: "100" },
      output: {
        type: "string",
        default: "training-data/trust-experiment-matrix",
      },
      run: { type: "boolean", default: false },
      "runtime-base-url": { type: "string" },
      "runtime-model": { type: "string" },
      "runtime-model-version": { type: "string" },
      seed: { type: "string", default: "1337" },
      "run-id": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    agentCount: parsePositiveInt(values.agents, 100),
    npcTargetCount: parsePositiveInt(values.npcs, 150),
    archetypeCount: parsePositiveInt(values.archetypes, 30),
    modelSizes: parseModelSizes(values["model-sizes"] as string),
    worldTicks: parseNonNegativeInt(values["world-ticks"], 2),
    agentTicks: parseNonNegativeInt(values["agent-ticks"], 1),
    initialGroupChatsMin: parseNonNegativeInt(
      values["initial-group-chats-min"],
      0,
    ),
    initialGroupChatsMax: parseNonNegativeInt(
      values["initial-group-chats-max"],
      6,
    ),
    parallel: parsePositiveInt(values.parallel, 8),
    delayMs: parseNonNegativeInt(values.delay, 350),
    outputDir: path.resolve(process.cwd(), values.output as string),
    run: values.run as boolean,
    runtimeBaseUrl: cleanOptionalString(
      (values["runtime-base-url"] as string | undefined) ??
        process.env.TRUST_EXPERIMENT_RUNTIME_BASE_URL,
    ),
    runtimeModel: cleanOptionalString(
      (values["runtime-model"] as string | undefined) ??
        process.env.TRUST_EXPERIMENT_RUNTIME_MODEL,
    ),
    runtimeModelVersion: cleanOptionalString(
      (values["runtime-model-version"] as string | undefined) ??
        process.env.TRUST_EXPERIMENT_RUNTIME_MODEL_VERSION,
    ),
    seed: parseNonNegativeInt(values.seed as string | undefined, 1337),
    runId: cleanOptionalString(values["run-id"] as string | undefined),
  };
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseModelSizes(value: string): TrustExperimentModelSize[] {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(
      (item): item is TrustExperimentModelSize =>
        item === "0.5b" ||
        item === "1.5b" ||
        item === "3b" ||
        item === "7b" ||
        item === "14b" ||
        item === "30b",
    );
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleInclusiveInt(
  rng: () => number,
  min: number,
  max: number,
): number {
  if (max <= min) {
    return min;
  }
  return min + Math.floor(rng() * (max - min + 1));
}

function buildConfigStyle(agent: TrustExperimentAgentSpec) {
  return {
    all: agent.sheet.style.all,
    chat: agent.sheet.style.chat,
    post: agent.sheet.style.post,
    feed: {
      sheetId: agent.sheet.id,
      instanceId: agent.instanceId,
      username: agent.sheet.username,
      models: agent.sheet.settings.groq,
      metadata: agent.sheet.feed,
      trustExperiment: {
        modelSize: agent.modelProfile.id,
        parameterCountB: agent.modelProfile.parameterCountB,
        trainingProfile: agent.modelProfile.trainingProfile,
      },
    },
  };
}

function buildAgentPersonalitySummary(agent: TrustExperimentAgentSpec): string {
  return [
    `${agent.sheet.feed.alignment} ${agent.sheet.feed.team} posture`,
    agent.sheet.feed.socialStyle,
    `scam:${agent.sheet.feed.scamProfile.replaceAll("_", " ")}`,
    `model:${agent.modelProfile.id}`,
    `profile:${agent.modelProfile.trainingProfile}`,
  ].join(" | ");
}

async function ensureExperimentAgent(
  agent: TrustExperimentAgentSpec,
): Promise<{ agentId: string; username: string }> {
  const deps = await getRunDeps();
  const result = await deps.createTestAgent(agent.instanceId, {
    username: agent.sheet.username,
    displayName: agent.sheet.name,
    virtualBalance: 25000,
    autonomousTrading: agent.sheet.feed.autonomy.trading,
    autonomousPosting: agent.sheet.feed.autonomy.posting,
    autonomousCommenting: agent.sheet.feed.autonomy.commenting,
    autonomousDMs: agent.sheet.feed.autonomy.dms,
    autonomousGroupChats: agent.sheet.feed.autonomy.groups,
    systemPrompt: agent.sheet.system,
  });

  await deps.db
    .update(deps.users)
    .set({
      displayName: agent.sheet.name,
      bio: agent.sheet.bio.join("\n"),
      updatedAt: new Date(),
    })
    .where(deps.eq(deps.users.id, result.agentId));

  await deps.upsertAgentConfig(result.agentId, {
    systemPrompt: agent.sheet.system,
    personality: buildAgentPersonalitySummary(agent),
    tradingStrategy: agent.sheet.feed.tradingStyle,
    style: buildConfigStyle(agent),
    messageExamples: agent.sheet.bio,
    personaPrompt: JSON.stringify(agent.sheet),
    goals: {
      motivations: agent.sheet.feed.motivations,
      fears: agent.sheet.feed.fears,
      topics: agent.sheet.topics,
    },
    directives: agent.sheet.style.all,
    constraints: [
      `alignment:${agent.sheet.feed.alignment}`,
      `team:${agent.sheet.feed.team}`,
      `scam_profile:${agent.sheet.feed.scamProfile}`,
      `model_size:${agent.modelProfile.id}`,
      `training_profile:${agent.modelProfile.trainingProfile}`,
    ],
    planningHorizon: "campaign",
    riskTolerance:
      agent.sheet.feed.caution === "paranoid"
        ? "low"
        : agent.sheet.feed.caution === "reckless"
          ? "high"
          : "medium",
    maxActionsPerTick: agent.sheet.feed.caution === "paranoid" ? 2 : 5,
    modelTier: agent.modelProfile.parameterCountB >= 14 ? "pro" : "free",
    autonomousTrading: agent.sheet.feed.autonomy.trading,
    autonomousPosting: agent.sheet.feed.autonomy.posting,
    autonomousCommenting: agent.sheet.feed.autonomy.commenting,
    autonomousDMs: agent.sheet.feed.autonomy.dms,
    autonomousGroupChats: agent.sheet.feed.autonomy.groups,
    a2aEnabled: false,
    updatedAt: new Date(),
  });

  return {
    agentId: result.agentId,
    username: result.agent.username,
  };
}

function applySheetToRuntime(
  runtime: IAgentRuntime,
  agent: TrustExperimentAgentSpec,
  options: Options,
): void {
  const runtimeModel =
    options.runtimeModel ?? agent.sheet.settings.groq.primary;
  const runtimeBaseUrl = options.runtimeBaseUrl;
  const runtimeModelVersion =
    options.runtimeModelVersion ?? agent.sheet.settings.model;

  const runtimeCharacter = runtime.character as RuntimeCharacter;
  runtimeCharacter.name = agent.sheet.name;
  runtimeCharacter.system = agent.sheet.system;
  runtimeCharacter.bio = [...agent.sheet.bio];
  runtimeCharacter.username = agent.sheet.username;
  runtimeCharacter.lore = [...agent.sheet.lore];
  runtimeCharacter.topics = [...agent.sheet.topics];
  runtimeCharacter.adjectives = [...agent.sheet.adjectives];
  runtimeCharacter.postExamples = [...agent.sheet.postExamples];
  runtimeCharacter.messageExamples = agent.sheet.messageExamples;
  runtimeCharacter.style = buildConfigStyle(agent);
  runtimeCharacter.settings = {
    ...(runtimeCharacter.settings || {}),
    GROQ_PRIMARY_MODEL: runtimeModel,
    GROQ_SMALL_MODEL: runtimeModel,
    GROQ_LARGE_MODEL: runtimeModel,
    ...(runtimeBaseUrl ? { GROQ_BASE_URL: runtimeBaseUrl } : {}),
    MODEL_VERSION: runtimeModelVersion,
    TEMPERATURE: String(agent.sheet.settings.temperature),
    MAX_TOKENS: String(agent.sheet.settings.maxTokens),
  };

  const runtimeWithSettings = runtime as RuntimeWithSettings;
  runtimeWithSettings.settings = {
    ...(runtimeWithSettings.settings || {}),
    GROQ_PRIMARY_MODEL: runtimeModel,
    GROQ_SMALL_MODEL: runtimeModel,
    GROQ_LARGE_MODEL: runtimeModel,
    ...(runtimeBaseUrl ? { GROQ_BASE_URL: runtimeBaseUrl } : {}),
    MODEL_VERSION: runtimeModelVersion,
  };
}

function setTrustContext(
  runtime: IAgentRuntime,
  agent: TrustExperimentAgentSpec,
): void {
  const feed = agent.sheet.feed;
  // Set trust outcomes on runtime for trajectory recording.
  // These are initialized from the character sheet's trust profile;
  // the autonomous coordinator reads them at endTrajectory.
  (runtime as { _trustOutcomes?: Record<string, unknown> })._trustOutcomes = {
    scamAttemptsDetected: 0,
    scamAttemptsFellFor: 0,
    scamLossesAvoided: 0,
    scamLossesIncurred: 0,
    unsafeDisclosures: 0,
    socialCapital: 0,
    // False positive tracking: legitimate interactions the agent accepted or rejected
    legitimateInteractionsAccepted: 0,
    legitimateInteractionsRejected: 0,
    // Ground-truth interaction labels (populated by coordinator from action trace)
    interactionLabels: [] as Array<{
      counterpartyId: string;
      counterpartyTeam: "red" | "blue" | "gray";
      counterpartyAlignment: "good" | "neutral" | "evil";
      channel: "dm" | "group-chat" | "payment" | "trade";
      amountTransferred?: number;
      messageCount: number;
      wasScam: boolean;
      wasLegitimate: boolean;
      wasRejected: boolean;
    }>,
    interactedWithRedTeam: feed.team === "red",
    interactedWithBlueTeam: feed.team === "blue",
    redTeamNpcIds: [] as string[],
    // Metadata for downstream filtering
    agentTeam: feed.team,
    agentAlignment: feed.alignment,
    agentScamProfile: feed.scamProfile,
    agentCaution: feed.caution,
    agentDeception: feed.deception,
  };
}

async function executeAgentTick(
  agent: TrustExperimentAgentSpec,
  agentId: string,
  options: Options,
  agentIdentityMap?: Map<
    string,
    { team: string; alignment: string; instanceId: string }
  >,
  experimentContext?: ExperimentTrajectoryContext,
  initialGroupChatSeedingByInstanceId?: Map<string, InitialGroupChatSeedRecord>,
): Promise<AgentTickSummary> {
  try {
    const deps = await getRunDeps();
    const runtime = await deps.agentRuntimeManager.getRuntime(agentId);
    applySheetToRuntime(runtime, agent, options);
    setTrustContext(runtime, agent);

    if (experimentContext) {
      const initialGroupChatSeed = initialGroupChatSeedingByInstanceId?.get(
        agent.instanceId,
      );
      const scenarioId = [
        "trust-exp",
        agent.modelProfile.trainingProfile,
        agent.sheet.feed.scamProfile,
        agent.sheet.feed.team,
        agent.modelProfile.id,
      ]
        .map((part) => String(part).trim())
        .filter(Boolean)
        .join(":")
        .slice(0, 96);
      (
        runtime as {
          _trajectoryRunContext?: {
            scenarioId: string;
            episodeId: string;
            batchId: string;
            metadata: Record<string, unknown>;
          };
        }
      )._trajectoryRunContext = {
        scenarioId,
        episodeId: `${experimentContext.experimentRunId}:${agent.instanceId}:r${experimentContext.roundNumber}`,
        batchId: experimentContext.experimentRunId,
        metadata: {
          experimentRunId: experimentContext.experimentRunId,
          roundNumber: experimentContext.roundNumber,
          totalRounds: experimentContext.totalRounds,
          randomSeed: experimentContext.seed,
          agentInstanceId: agent.instanceId,
          username: agent.sheet.username,
          displayName: agent.sheet.name,
          modelSize: agent.modelProfile.id,
          parameterCountB: agent.modelProfile.parameterCountB,
          trainingProfile: agent.modelProfile.trainingProfile,
          team: agent.sheet.feed.team,
          alignment: agent.sheet.feed.alignment,
          scamProfile: agent.sheet.feed.scamProfile,
          caution: agent.sheet.feed.caution,
          deception: agent.sheet.feed.deception,
          socialStyle: agent.sheet.feed.socialStyle,
          scenarioProfile: `${agent.sheet.feed.team}:${agent.sheet.feed.scamProfile}:${agent.modelProfile.trainingProfile}`,
          initialGroupChatTarget:
            initialGroupChatSeed?.targetGroupChatCount ?? null,
          initialGroupChatCount:
            initialGroupChatSeed?.assignedGroupChatCount ?? null,
          initialGroupChatIds: initialGroupChatSeed?.assignedChatIds ?? [],
        },
      };
    }

    // Attach agent identity map so the coordinator can label interactions
    if (agentIdentityMap) {
      (
        runtime as {
          _agentIdentityMap?: Map<
            string,
            { team: string; alignment: string; instanceId: string }
          >;
        }
      )._agentIdentityMap = agentIdentityMap;
    }

    const result = await deps.autonomousCoordinator.executeAutonomousTick(
      agentId,
      runtime,
      true,
    );

    return {
      instanceId: agent.instanceId,
      username: agent.sheet.username,
      success: result.success,
      trajectoryId: result.trajectoryId,
      error: result.error,
    };
  } catch (error) {
    return {
      instanceId: agent.instanceId,
      username: agent.sheet.username,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runAgentTickRound(
  agents: TrustExperimentAgentSpec[],
  idByInstanceId: Map<string, string>,
  options: Options,
  parallel: number,
  delayMs: number,
  agentIdentityMap?: Map<
    string,
    { team: string; alignment: string; instanceId: string }
  >,
  experimentContext?: ExperimentTrajectoryContext,
  initialGroupChatSeedingByInstanceId?: Map<string, InitialGroupChatSeedRecord>,
): Promise<AgentTickSummary[]> {
  const summaries: AgentTickSummary[] = [];

  for (let index = 0; index < agents.length; index += parallel) {
    const batch = agents.slice(index, index + parallel);
    const batchResults = await Promise.all(
      batch.map(async (agent) => {
        const agentId = idByInstanceId.get(agent.instanceId);
        if (!agentId) {
          return {
            instanceId: agent.instanceId,
            username: agent.sheet.username,
            success: false,
            error: `Missing agent for instance ${agent.instanceId}`,
          } satisfies AgentTickSummary;
        }
        return executeAgentTick(
          agent,
          agentId,
          options,
          agentIdentityMap,
          experimentContext,
          initialGroupChatSeedingByInstanceId,
        );
      }),
    );

    summaries.push(...batchResults);
    if (index + parallel < agents.length && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return summaries;
}

async function readNpcGroupChatMemberships(
  userIds: string[],
): Promise<Map<string, string[]>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const deps = await getRunDeps();
  const rows = await deps.db
    .select({
      userId: deps.groupMembers.userId,
      chatId: deps.chats.id,
    })
    .from(deps.groupMembers)
    .innerJoin(deps.groups, deps.eq(deps.groups.id, deps.groupMembers.groupId))
    .innerJoin(deps.chats, deps.eq(deps.chats.groupId, deps.groups.id))
    .where(
      deps.and(
        deps.inArray(deps.groupMembers.userId, userIds),
        deps.eq(deps.groupMembers.isActive, true),
        deps.eq(deps.groups.type, "npc"),
        deps.eq(deps.chats.isGroup, true),
      ),
    );

  const memberships = new Map<string, string[]>();
  for (const row of rows) {
    const chatIds = memberships.get(row.userId) ?? [];
    chatIds.push(row.chatId);
    memberships.set(row.userId, chatIds);
  }

  for (const [userId, chatIds] of memberships.entries()) {
    memberships.set(userId, [...new Set(chatIds)].sort());
  }

  return memberships;
}

async function seedInitialAgentGroupChats(
  agents: TrustExperimentAgentSpec[],
  idByInstanceId: Map<string, string>,
  registeredAgents: RegisteredAgentSummary[],
  options: Options,
): Promise<InitialGroupChatSeedingSummary> {
  const min = Math.max(0, options.initialGroupChatsMin);
  const max = Math.max(min, options.initialGroupChatsMax);
  const rng = createSeededRandom(options.seed ^ 0x9e3779b9);
  const deps = await getRunDeps();
  const targets = agents.map((agent) => {
    const agentId = idByInstanceId.get(agent.instanceId);
    if (!agentId) {
      throw new Error(`Missing registered agent for ${agent.instanceId}`);
    }
    return {
      agent,
      agentId,
      targetGroupChatCount: sampleInclusiveInt(rng, min, max),
    };
  });

  for (const target of targets) {
    if (target.targetGroupChatCount <= 0) {
      continue;
    }

    await deps.autoJoinEmptyUsersToNpcGroupChats({
      enabled: true,
      batchSize: 1,
      targetChatsPerUser: target.targetGroupChatCount,
      defaultMaxMembers: 25,
      userIdAllowlist: [target.agentId],
      rng,
    });
  }

  const membershipsByAgentId = await readNpcGroupChatMemberships(
    targets.map((target) => target.agentId),
  );

  const agentsWithSeeding: InitialGroupChatSeedRecord[] = targets.map(
    (target) => {
      const assignedChatIds =
        membershipsByAgentId.get(target.agentId)?.slice().sort() ?? [];
      const record: InitialGroupChatSeedRecord = {
        instanceId: target.agent.instanceId,
        agentId: target.agentId,
        username: target.agent.sheet.username,
        displayName: target.agent.sheet.name,
        targetGroupChatCount: target.targetGroupChatCount,
        assignedGroupChatCount: assignedChatIds.length,
        assignedChatIds,
      };

      const registered = registeredAgents.find(
        (item) => item.instanceId === target.agent.instanceId,
      );
      if (registered) {
        registered.initialGroupChatTarget = record.targetGroupChatCount;
        registered.initialGroupChatCount = record.assignedGroupChatCount;
        registered.initialGroupChatIds = record.assignedChatIds;
      }

      return record;
    },
  );

  return {
    configuredRange: { min, max },
    targetedAgentCount: agentsWithSeeding.length,
    zeroTargetAgentCount: agentsWithSeeding.filter(
      (item) => item.targetGroupChatCount === 0,
    ).length,
    requestedAssignments: agentsWithSeeding.reduce(
      (sum, item) => sum + item.targetGroupChatCount,
      0,
    ),
    assignedMembershipCount: agentsWithSeeding.reduce(
      (sum, item) => sum + item.assignedGroupChatCount,
      0,
    ),
    agents: agentsWithSeeding,
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  process.env.FEED_DISABLE_A2A ??= "1";
  process.env.FEED_SUPPRESS_OPTIONAL_LLM_WARNINGS ??= "1";
  if (process.env.FEED_SUPPRESS_OPTIONAL_LLM_WARNINGS === "1") {
    delete process.env.OPENAI_API_KEY;
    process.env.SECRET_SALT ??= "feed-trust-experiment";
  }
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const experimentRunId =
    options.runId ?? `trust-experiment-${timestamp.toLowerCase()}`;
  const outputDir = path.join(options.outputDir, timestamp);
  const sheetsDir = path.join(outputDir, "character-sheets");
  const agents = buildTrustExperimentAgents({
    agentCount: options.agentCount,
    npcTargetCount: options.npcTargetCount,
    archetypeCount: options.archetypeCount,
    modelSizes: options.modelSizes,
  });
  const manifest = buildTrustExperimentManifest({
    agentCount: options.agentCount,
    npcTargetCount: options.npcTargetCount,
    archetypeCount: options.archetypeCount,
    modelSizes: options.modelSizes,
  });

  await mkdir(outputDir, { recursive: true });
  await writeTrustExperimentCharacterSheets(sheetsDir, agents);
  await writeFile(
    path.join(outputDir, "manifest.json"),
    `${JSON.stringify(
      {
        ...manifest,
        experimentRunId,
        batchId: experimentRunId,
        seed: options.seed,
        availableStaticNpcCount: staticActors.length,
        initialGroupChatRange: {
          min: options.initialGroupChatsMin,
          max: options.initialGroupChatsMax,
        },
        runRequested: options.run,
        runtimeOverride:
          options.runtimeBaseUrl ||
          options.runtimeModel ||
          options.runtimeModelVersion
            ? {
                baseUrl: options.runtimeBaseUrl ?? null,
                model: options.runtimeModel ?? null,
                modelVersion: options.runtimeModelVersion ?? null,
              }
            : null,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  console.log("Trust experiment matrix prepared");
  console.log(`Output directory: ${outputDir}`);
  console.log(`Agents: ${manifest.agentTargetCount}`);
  console.log(`Archetypes: ${manifest.archetypeCount}`);
  console.log(`Requested NPC target: ${manifest.npcTargetCount}`);
  console.log(`Available static NPCs: ${staticActors.length}`);
  console.log(`Model breakdown: ${JSON.stringify(manifest.modelBreakdown)}`);
  if (
    options.runtimeBaseUrl ||
    options.runtimeModel ||
    options.runtimeModelVersion
  ) {
    console.log(
      `Runtime override: ${JSON.stringify({
        baseUrl: options.runtimeBaseUrl ?? null,
        model: options.runtimeModel ?? null,
        modelVersion: options.runtimeModelVersion ?? null,
      })}`,
    );
  }

  if (!options.run) {
    console.log("Run skipped. Re-run with --run to execute the matrix.");
    return;
  }

  const deps = await getRunDeps();

  const idByInstanceId = new Map<string, string>();
  // Agent identity map: agentId → {team, alignment} for interaction labeling
  const agentIdentityMap = new Map<
    string,
    { team: string; alignment: string; instanceId: string }
  >();
  const registeredAgents: RegisteredAgentSummary[] = [];
  for (const agent of agents) {
    const ensured = await ensureExperimentAgent(agent);
    idByInstanceId.set(agent.instanceId, ensured.agentId);
    agentIdentityMap.set(ensured.agentId, {
      team: agent.sheet.feed.team,
      alignment: agent.sheet.feed.alignment,
      instanceId: agent.instanceId,
    });
    registeredAgents.push({
      instanceId: agent.instanceId,
      agentId: ensured.agentId,
      username: agent.sheet.username,
      displayName: agent.sheet.name,
      modelSize: agent.modelProfile.id,
      trainingProfile: agent.modelProfile.trainingProfile,
    });
    console.log(
      `Ready: ${agent.sheet.name} (@${agent.sheet.username}) -> ${ensured.agentId}`,
    );
  }
  await writeFile(
    path.join(outputDir, "registered-agents.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        experimentRunId,
        batchId: experimentRunId,
        agents: registeredAgents,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  const worldTickSummaries: Array<{
    tick: number;
    postsCreated: number;
    eventsCreated: number;
    marketsUpdated: number;
    questionsCreated: number;
  }> = [];
  for (let tick = 0; tick < options.worldTicks; tick++) {
    const result = await deps.executeGameTick(false);
    worldTickSummaries.push({
      tick: tick + 1,
      postsCreated: result.postsCreated,
      eventsCreated: result.eventsCreated,
      marketsUpdated: result.marketsUpdated,
      questionsCreated: result.questionsCreated,
    });
    console.log(
      `World tick ${tick + 1}/${options.worldTicks}: posts=${result.postsCreated} events=${result.eventsCreated}`,
    );
  }

  const initialGroupChatSeeding = await seedInitialAgentGroupChats(
    agents,
    idByInstanceId,
    registeredAgents,
    options,
  );
  const initialGroupChatSeedingByInstanceId = new Map(
    initialGroupChatSeeding.agents.map((agent) => [agent.instanceId, agent]),
  );
  await writeFile(
    path.join(outputDir, "registered-agents.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        experimentRunId,
        batchId: experimentRunId,
        initialGroupChatSeeding,
        agents: registeredAgents,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await writeFile(
    path.join(outputDir, "initial-group-chat-seeding.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        experimentRunId,
        batchId: experimentRunId,
        ...initialGroupChatSeeding,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  console.log(
    `Initial group-chat seeding complete: assigned=${initialGroupChatSeeding.assignedMembershipCount} requested=${initialGroupChatSeeding.requestedAssignments} zeroTarget=${initialGroupChatSeeding.zeroTargetAgentCount}`,
  );

  // Darwinian agent weighting (ATLAS-inspired)
  // Track per-agent performance across rounds; weight determines execution probability via quartile ranking
  const agentWeights = new Map<string, number>();
  const random = createSeededRandom(options.seed);
  for (const agent of agents) {
    agentWeights.set(agent.instanceId, 1.0);
  }

  const agentSummaries: AgentTickSummary[] = [];
  for (let round = 0; round < options.agentTicks; round++) {
    // Sort agents by weight (higher weight = executed first, more likely to interact)
    const weightedAgents = [...agents].sort((a, b) => {
      const wa = agentWeights.get(a.instanceId) ?? 1.0;
      const wb = agentWeights.get(b.instanceId) ?? 1.0;
      return wb - wa; // Descending
    });

    // Filter agents by weight-based probability
    const activeAgents = weightedAgents.filter((agent) => {
      const weight = agentWeights.get(agent.instanceId) ?? 1.0;
      // Weight of 1.0 = always execute, 0.3 = 30% chance, 2.5 = always (capped at 1.0 probability)
      return random() < Math.min(1.0, weight);
    });

    console.log(
      `Agent round ${round + 1}/${options.agentTicks} running for ${activeAgents.length}/${weightedAgents.length} agents (filtered by weight)`,
    );
    const roundSummaries = await runAgentTickRound(
      activeAgents,
      idByInstanceId,
      options,
      options.parallel,
      options.delayMs,
      agentIdentityMap,
      {
        experimentRunId,
        roundNumber: round + 1,
        totalRounds: options.agentTicks,
        seed: options.seed,
      },
      initialGroupChatSeedingByInstanceId,
    );
    agentSummaries.push(...roundSummaries);
    const successCount = roundSummaries.filter((item) => item.success).length;

    // Update Darwinian weights based on round performance quartiles
    const performances = roundSummaries
      .map((s) => ({ instanceId: s.instanceId, perf: s.success ? 1 : 0 }))
      .sort((a, b) => b.perf - a.perf);

    const q1Cutoff = Math.max(1, Math.ceil(performances.length * 0.25));
    const q3Cutoff = Math.floor(performances.length * 0.75);

    for (let i = 0; i < performances.length; i++) {
      const { instanceId } = performances[i]!;
      const currentWeight = agentWeights.get(instanceId) ?? 1.0;
      let adjustment = 1.0;
      if (i < q1Cutoff)
        adjustment = 1.05; // top quartile
      else if (i >= q3Cutoff) adjustment = 0.95; // bottom quartile
      agentWeights.set(
        instanceId,
        Math.max(0.3, Math.min(2.5, currentWeight * adjustment)),
      );
    }

    console.log(
      `Round ${round + 1} complete: success=${successCount} failed=${roundSummaries.length - successCount}`,
    );

    // Checkpoint after each round so interrupted runs preserve completed data
    const checkpointAggregate: RunSummaryAggregate = {
      successCount: agentSummaries.filter((item) => item.success).length,
      failedCount: agentSummaries.filter((item) => !item.success).length,
      successRate:
        agentSummaries.length > 0
          ? agentSummaries.filter((item) => item.success).length /
            agentSummaries.length
          : null,
      agentTickSuccessRate:
        agentSummaries.length > 0
          ? agentSummaries.filter((item) => item.success).length /
            agentSummaries.length
          : null,
    };
    await writeFile(
      path.join(outputDir, "checkpoint.json"),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          experimentRunId,
          batchId: experimentRunId,
          completedRounds: round + 1,
          totalRounds: options.agentTicks,
          isCheckpoint: true,
          agentSummaries,
          aggregate: checkpointAggregate,
          initialGroupChatSeeding,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }

  const successCount = agentSummaries.filter((item) => item.success).length;
  const failedCount = agentSummaries.length - successCount;
  const aggregate: RunSummaryAggregate = {
    successCount,
    failedCount,
    successRate:
      agentSummaries.length > 0 ? successCount / agentSummaries.length : null,
    agentTickSuccessRate:
      agentSummaries.length > 0 ? successCount / agentSummaries.length : null,
  };

  await writeFile(
    path.join(outputDir, "run-summary.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        experimentRunId,
        batchId: experimentRunId,
        completedRounds: options.agentTicks,
        totalRounds: options.agentTicks,
        completedCleanly: true,
        interrupted: false,
        options,
        runtimeOverride:
          options.runtimeBaseUrl ||
          options.runtimeModel ||
          options.runtimeModelVersion
            ? {
                baseUrl: options.runtimeBaseUrl ?? null,
                model: options.runtimeModel ?? null,
                modelVersion: options.runtimeModelVersion ?? null,
              }
            : null,
        registeredAgents,
        initialGroupChatSeeding,
        worldTickSummaries,
        agentSummaries,
        summaries: agentSummaries,
        aggregate,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  console.log(
    `Saved run summary to ${path.join(outputDir, "run-summary.json")}`,
  );
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
