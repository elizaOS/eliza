import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type FeedCharacterSheet,
  buildCanonicalSimulationRoster,
  type GroqModelRouting,
} from './local-roster';

export type TrustExperimentModelSize =
  | '0.5b'
  | '1.5b'
  | '3b'
  | '7b'
  | '14b'
  | '30b';

export interface TrustExperimentModelProfile {
  id: TrustExperimentModelSize;
  label: string;
  parameterCountB: number;
  baseModel: string;
  trainingProfile: string;
  runtimeRouting: GroqModelRouting;
}

export interface TrustExperimentAgentSpec {
  instanceId: string;
  variantIndex: number;
  modelProfile: TrustExperimentModelProfile;
  sheet: FeedCharacterSheet;
}

export interface TrustExperimentManifest {
  generatedAt: string;
  agentTargetCount: number;
  npcTargetCount: number;
  archetypeCount: number;
  modelSizes: TrustExperimentModelSize[];
  modelBreakdown: Record<string, number>;
  teamBreakdown: Record<string, number>;
  agents: Array<{
    instanceId: string;
    characterId: string;
    username: string;
    team: string;
    alignment: string;
    modelSize: TrustExperimentModelSize;
    parameterCountB: number;
    baseModel: string;
    runtimeModel: string;
    trainingProfile: string;
  }>;
}

export interface TrustExperimentOptions {
  agentCount?: number;
  npcTargetCount?: number;
  archetypeCount?: number;
  modelSizes?: TrustExperimentModelSize[];
}

export const TRUST_EXPERIMENT_MODEL_PROFILES: Record<
  TrustExperimentModelSize,
  TrustExperimentModelProfile
> = {
  '0.5b': {
    id: '0.5b',
    label: 'Qwen2.5 0.5B',
    parameterCountB: 0.5,
    baseModel: 'Qwen/Qwen2.5-0.5B-Instruct',
    trainingProfile: '12gb',
    runtimeRouting: {
      primary: 'llama-3.1-8b-instant',
      small: 'llama-3.1-8b-instant',
      large: 'llama-3.1-8b-instant',
    },
  },
  '1.5b': {
    id: '1.5b',
    label: 'Qwen2.5 1.5B',
    parameterCountB: 1.5,
    baseModel: 'Qwen/Qwen2.5-1.5B-Instruct',
    trainingProfile: '16gb',
    runtimeRouting: {
      primary: 'openai/gpt-oss-20b',
      small: 'llama-3.1-8b-instant',
      large: 'openai/gpt-oss-20b',
    },
  },
  '3b': {
    id: '3b',
    label: 'Qwen2.5 3B',
    parameterCountB: 3,
    baseModel: 'Qwen/Qwen2.5-3B-Instruct',
    trainingProfile: '24gb',
    runtimeRouting: {
      primary: 'openai/gpt-oss-120b',
      small: 'llama-3.1-8b-instant',
      large: 'openai/gpt-oss-120b',
    },
  },
  '7b': {
    id: '7b',
    label: 'Qwen2.5 7B',
    parameterCountB: 7,
    baseModel: 'Qwen/Qwen2.5-7B-Instruct',
    trainingProfile: '48gb',
    runtimeRouting: {
      primary: 'llama-3.3-70b-versatile',
      small: 'llama-3.1-8b-instant',
      large: 'llama-3.3-70b-versatile',
    },
  },
  '14b': {
    id: '14b',
    label: 'Qwen2.5 14B',
    parameterCountB: 14,
    baseModel: 'Qwen/Qwen2.5-14B-Instruct',
    trainingProfile: 'h100',
    runtimeRouting: {
      primary: 'openai/gpt-oss-120b',
      small: 'openai/gpt-oss-20b',
      large: 'openai/gpt-oss-120b',
    },
  },
  '30b': {
    id: '30b',
    label: 'Qwen3 30B',
    parameterCountB: 30,
    baseModel: 'Qwen/Qwen3-30B-A3B',
    trainingProfile: 'h100-4gpu',
    runtimeRouting: {
      primary: 'moonshotai/kimi-k2-instruct-0905',
      small: 'openai/gpt-oss-20b',
      large: 'moonshotai/kimi-k2-instruct-0905',
    },
  },
};

export function buildTrustExperimentAgents(
  options: TrustExperimentOptions = {}
): TrustExperimentAgentSpec[] {
  const canonicalRoster = buildCanonicalSimulationRoster();
  const archetypeCount = Math.min(
    options.archetypeCount ?? 30,
    canonicalRoster.length
  );
  const archetypes = canonicalRoster.slice(0, archetypeCount);
  const modelSizes =
    options.modelSizes ??
    (Object.keys(
      TRUST_EXPERIMENT_MODEL_PROFILES
    ) as TrustExperimentModelSize[]);
  const agentCount = options.agentCount ?? 100;

  const agents: TrustExperimentAgentSpec[] = [];
  let index = 0;

  while (agents.length < agentCount) {
    const baseSheet = archetypes[index % archetypes.length]!;
    const modelSize = modelSizes[index % modelSizes.length]!;
    const variantIndex = Math.floor(index / archetypes.length) + 1;
    const modelProfile = TRUST_EXPERIMENT_MODEL_PROFILES[modelSize];

    agents.push({
      instanceId: `${baseSheet.id}-${modelProfile.id}-v${variantIndex}`,
      variantIndex,
      modelProfile,
      sheet: buildExperimentCharacterSheet(
        baseSheet,
        modelProfile,
        variantIndex
      ),
    });

    index += 1;
  }

  return agents;
}

export function buildTrustExperimentManifest(
  options: TrustExperimentOptions = {}
): TrustExperimentManifest {
  const agents = buildTrustExperimentAgents(options);
  const modelBreakdown: Record<string, number> = {};
  const teamBreakdown: Record<string, number> = {};

  for (const agent of agents) {
    modelBreakdown[agent.modelProfile.id] =
      (modelBreakdown[agent.modelProfile.id] ?? 0) + 1;
    teamBreakdown[agent.sheet.feed.team] =
      (teamBreakdown[agent.sheet.feed.team] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    agentTargetCount: agents.length,
    npcTargetCount: options.npcTargetCount ?? 150,
    archetypeCount: Math.min(options.archetypeCount ?? 30, 30),
    modelSizes:
      options.modelSizes ??
      (Object.keys(
        TRUST_EXPERIMENT_MODEL_PROFILES
      ) as TrustExperimentModelSize[]),
    modelBreakdown,
    teamBreakdown,
    agents: agents.map((agent) => ({
      instanceId: agent.instanceId,
      characterId: agent.sheet.id,
      username: agent.sheet.username,
      team: agent.sheet.feed.team,
      alignment: agent.sheet.feed.alignment,
      modelSize: agent.modelProfile.id,
      parameterCountB: agent.modelProfile.parameterCountB,
      baseModel: agent.modelProfile.baseModel,
      runtimeModel: agent.modelProfile.runtimeRouting.primary,
      trainingProfile: agent.modelProfile.trainingProfile,
    })),
  };
}

export async function writeTrustExperimentCharacterSheets(
  outputDirectory: string,
  agents: TrustExperimentAgentSpec[]
): Promise<string[]> {
  await mkdir(outputDirectory, { recursive: true });
  const filePaths: string[] = [];

  for (const agent of agents) {
    const filePath = path.join(outputDirectory, `${agent.instanceId}.json`);
    await writeFile(
      filePath,
      JSON.stringify(agent.sheet, null, 2) + '\n',
      'utf-8'
    );
    filePaths.push(filePath);
  }

  return filePaths;
}

function buildExperimentCharacterSheet(
  baseSheet: FeedCharacterSheet,
  modelProfile: TrustExperimentModelProfile,
  variantIndex: number
): FeedCharacterSheet {
  const suffix = `${modelProfile.id.replace('.', '_')}v${variantIndex}`;
  const username = `${baseSheet.username}_${suffix}`.slice(0, 32);

  return {
    ...baseSheet,
    id: `${baseSheet.id}-${modelProfile.id}-v${variantIndex}`,
    name: `${baseSheet.name} [${modelProfile.label}]`,
    username,
    bio: [
      ...baseSheet.bio,
      `Trust experiment variant ${variantIndex} using ${modelProfile.baseModel}.`,
      `Training profile: ${modelProfile.trainingProfile}.`,
      `Runtime provider route: ${modelProfile.runtimeRouting.primary}.`,
    ],
    lore: [...baseSheet.lore, `Model-size cohort: ${modelProfile.id}.`],
    settings: {
      ...baseSheet.settings,
      model: modelProfile.baseModel,
      groq: modelProfile.runtimeRouting,
    },
    feed: {
      ...baseSheet.feed,
      datasetTags: [
        ...baseSheet.feed.datasetTags,
        `model_size:${modelProfile.id}`,
        `training_profile:${modelProfile.trainingProfile}`,
        `runtime_model:${modelProfile.runtimeRouting.primary}`,
        `variant:${variantIndex}`,
      ],
    },
  };
}
