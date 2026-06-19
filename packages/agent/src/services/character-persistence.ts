import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  type ElizaConfig,
  loadElizaConfig,
  saveElizaConfig,
} from "../config/config.ts";
import {
  type CharacterHistorySource,
  type RuntimeCharacterLike,
  recordCharacterHistory,
} from "./character-history.ts";

export const CHARACTER_PERSISTENCE_SERVICE = "eliza_character_persistence";

type PersistCharacterParams = {
  character?: RuntimeCharacterLike;
  previousCharacter?: RuntimeCharacterLike;
  previousName?: string;
  source?: CharacterHistorySource;
};

type PersistCharacterResult = {
  success: boolean;
  error?: string;
};

type AgentConfigLike = NonNullable<ElizaConfig["agents"]>["list"] extends
  | Array<infer T>
  | undefined
  ? T
  : never;

function cloneStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return strings.length > 0 ? [...strings] : [];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function syncCharacterIntoConfig(
  config: ElizaConfig,
  character: RuntimeCharacterLike,
): AgentConfigLike {
  if (!config.agents) config.agents = {};

  const existingList = config.agents.list ?? [];
  const primaryAgent: AgentConfigLike = existingList[0] ?? {
    id: "main",
    default: true,
  };

  const nextAgent = {
    ...primaryAgent,
    ...(typeof character.name === "string" && character.name.trim()
      ? { name: character.name.trim() }
      : {}),
    ...(typeof character.username === "string" && character.username.trim()
      ? { username: character.username.trim() }
      : {}),
    ...(Array.isArray(character.bio)
      ? { bio: cloneStringArray(character.bio) }
      : typeof character.bio === "string" && character.bio.trim()
        ? { bio: [character.bio] }
        : {}),
    ...(typeof character.system === "string"
      ? { system: character.system }
      : {}),
    ...(Array.isArray(character.adjectives)
      ? { adjectives: cloneStringArray(character.adjectives) }
      : {}),
    ...(Array.isArray(character.topics)
      ? { topics: cloneStringArray(character.topics) }
      : {}),
    ...(character.style
      ? {
          style: {
            ...(Array.isArray(character.style.all)
              ? { all: [...character.style.all] }
              : {}),
            ...(Array.isArray(character.style.chat)
              ? { chat: [...character.style.chat] }
              : {}),
            ...(Array.isArray(character.style.post)
              ? { post: [...character.style.post] }
              : {}),
          },
        }
      : {}),
    ...(Array.isArray(character.postExamples)
      ? { postExamples: cloneStringArray(character.postExamples) }
      : {}),
    ...(Array.isArray(character.messageExamples)
      ? { messageExamples: cloneJson(character.messageExamples) }
      : {}),
  } as AgentConfigLike;

  config.agents.list = [nextAgent, ...existingList.slice(1)];

  config.ui ??= {};
  const uiConfig = config.ui as {
    assistant?: { name?: string };
  };
  if (typeof nextAgent.name === "string" && nextAgent.name.trim()) {
    uiConfig.assistant = {
      ...(uiConfig.assistant ?? {}),
      name: nextAgent.name,
    };
  }

  return nextAgent;
}

function buildPersistedCharacterData(
  character: RuntimeCharacterLike,
): Record<string, unknown> {
  const persisted: Record<string, unknown> = {};

  if (typeof character.name === "string" && character.name.trim()) {
    persisted.name = character.name.trim();
  }
  if (typeof character.username === "string" && character.username.trim()) {
    persisted.username = character.username.trim();
  }
  if (Array.isArray(character.bio)) {
    persisted.bio = [...character.bio];
  } else if (typeof character.bio === "string" && character.bio.trim()) {
    persisted.bio = [character.bio];
  }
  if (typeof character.system === "string") {
    persisted.system = character.system;
  }
  if (Array.isArray(character.adjectives)) {
    persisted.adjectives = [...character.adjectives];
  }
  if (Array.isArray(character.topics)) {
    persisted.topics = [...character.topics];
  }
  if (character.style) {
    persisted.style = cloneJson(character.style);
  }
  if (Array.isArray(character.messageExamples)) {
    persisted.messageExamples = cloneJson(character.messageExamples);
  }
  if (Array.isArray(character.postExamples)) {
    persisted.postExamples = [...character.postExamples];
  }
  if (
    character.settings &&
    typeof character.settings === "object" &&
    !Array.isArray(character.settings)
  ) {
    persisted.settings = cloneJson(character.settings);
  }

  return persisted;
}

export class ElizaCharacterPersistenceService extends Service {
  static serviceType = CHARACTER_PERSISTENCE_SERVICE;

  static async start(
    runtime: IAgentRuntime,
  ): Promise<ElizaCharacterPersistenceService> {
    return new ElizaCharacterPersistenceService(runtime);
  }

  capabilityDescription =
    "Persists runtime character changes to Eliza config, agent storage, and history";

  async persistCharacter(
    params: PersistCharacterParams = {},
  ): Promise<PersistCharacterResult> {
    const runtimeCharacter = (params.character ??
      this.runtime.character) as RuntimeCharacterLike;
    const previousCharacter = (params.previousCharacter ??
      this.runtime.character) as RuntimeCharacterLike;

    try {
      const config = loadElizaConfig();
      const nextAgent = syncCharacterIntoConfig(config, runtimeCharacter);
      saveElizaConfig(config);

      const persistedCharacter = buildPersistedCharacterData(runtimeCharacter);
      const runtimeMetadata =
        runtimeCharacter.metadata &&
        typeof runtimeCharacter.metadata === "object" &&
        !Array.isArray(runtimeCharacter.metadata)
          ? runtimeCharacter.metadata
          : {};

      await this.runtime.updateAgent(this.runtime.agentId, {
        name:
          (typeof nextAgent.name === "string" && nextAgent.name.trim()) ||
          this.runtime.character.name,
        metadata: {
          ...runtimeMetadata,
          character: persistedCharacter,
        },
      });

      await recordCharacterHistory(this.runtime, {
        previousCharacter,
        nextCharacter: runtimeCharacter,
        source: params.source ?? "agent",
      });

      logger.info(
        {
          agentId: this.runtime.agentId,
          fields: Object.keys(persistedCharacter),
        },
        "Persisted runtime character changes",
      );

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          agentId: this.runtime.agentId,
          previousName: params.previousName,
          error: message,
        },
        "Failed to persist runtime character changes",
      );
      return { success: false, error: message };
    }
  }

  async stop(): Promise<void> {}
}
