import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { AgentContext } from "./context-types.js";
import type {
  ElizaNativeTrainingExample,
  TrainingSample,
} from "./dataset-generator.js";
import { toElizaNativeFormat } from "./dataset-generator.js";

export interface RoleplayTurn {
  id: string;
  role: "participant" | "assistant";
  speaker: string;
  content: string;
  isEvaluationTarget: boolean;
}

export interface RoleplayEpisode {
  id: string;
  blueprintId: string;
  agentName: string;
  platform: string;
  roomType: "group";
  primaryContext: AgentContext;
  secondaryContexts: AgentContext[];
  expectedDecision: "RESPOND" | "IGNORE" | "STOP";
  expectedAction?: string;
  evaluationTurnId: string;
  turns: RoleplayTurn[];
  metadata: {
    pattern: string;
    generatedBy: string;
    generatedAt: string;
    sourceSampleId: string;
  };
}

export interface RoleplayManifestLine {
  episodeId: string;
  blueprintId: string;
  agentName: string;
  evaluationTurnId: string;
  expectedDecision: "RESPOND" | "IGNORE" | "STOP";
  primaryContext: AgentContext;
  secondaryContexts: AgentContext[];
  expectedAction?: string;
  conversation: Array<{
    id: string;
    role: "participant" | "assistant";
    speaker: string;
    content: string;
  }>;
}

export interface RoleplayExportPaths {
  episodesPath: string;
  manifestPath: string;
  tuningPath: string;
}

export function buildRoleplayEpisode(sample: TrainingSample): RoleplayEpisode {
  const turns: RoleplayTurn[] = sample.messages.map((message, index) => {
    const turnId = `turn-${String(index + 1).padStart(3, "0")}`;
    const isAssistant = message.role === "assistant";
    return {
      id: turnId,
      role: isAssistant ? "assistant" : "participant",
      speaker: isAssistant ? sample.agentName : (message.name ?? "participant"),
      content: message.content,
      isEvaluationTarget: index === sample.messages.length - 1,
    };
  });

  return {
    id: randomUUID(),
    blueprintId: sample.blueprintId,
    agentName: sample.agentName,
    platform: sample.metadata.platform,
    roomType: "group",
    primaryContext: sample.expectedOutput.primaryContext,
    secondaryContexts: sample.expectedOutput.secondaryContexts,
    expectedDecision: sample.expectedOutput.decision,
    expectedAction: sample.expectedOutput.expectedAction,
    evaluationTurnId: turns[turns.length - 1]?.id ?? "turn-001",
    turns,
    metadata: {
      pattern: sample.metadata.pattern,
      generatedBy: sample.metadata.generatedBy,
      generatedAt: sample.metadata.generatedAt,
      sourceSampleId: sample.id,
    },
  };
}

export function buildRoleplayEpisodes(
  samples: TrainingSample[],
): RoleplayEpisode[] {
  return samples.map(buildRoleplayEpisode);
}

export function toRoleplayManifestLine(
  episode: RoleplayEpisode,
): RoleplayManifestLine {
  return {
    episodeId: episode.id,
    blueprintId: episode.blueprintId,
    agentName: episode.agentName,
    evaluationTurnId: episode.evaluationTurnId,
    expectedDecision: episode.expectedDecision,
    primaryContext: episode.primaryContext,
    secondaryContexts: episode.secondaryContexts,
    expectedAction: episode.expectedAction,
    conversation: episode.turns.map((turn) => ({
      id: turn.id,
      role: turn.role,
      speaker: turn.speaker,
      content: turn.content,
    })),
  };
}

export async function exportRoleplayEpisodes(
  episodes: RoleplayEpisode[],
  samples: TrainingSample[],
  outputDir: string,
): Promise<RoleplayExportPaths> {
  await mkdir(outputDir, { recursive: true });

  const episodesPath = join(outputDir, "roleplay_episodes.json");
  const manifestPath = join(outputDir, "roleplay_manifest.jsonl");
  const tuningPath = join(outputDir, "roleplay_tuning_examples.jsonl");

  await writeFile(episodesPath, JSON.stringify(episodes, null, 2));

  const manifestLines = episodes.map((episode) =>
    JSON.stringify(toRoleplayManifestLine(episode)),
  );
  await writeFile(manifestPath, `${manifestLines.join("\n")}\n`);

  const tuningLines = samples.map((sample) =>
    JSON.stringify(toElizaNativeFormat(sample, true) as ElizaNativeTrainingExample),
  );
  await writeFile(tuningPath, `${tuningLines.join("\n")}\n`);

  return {
    episodesPath,
    manifestPath,
    tuningPath,
  };
}
