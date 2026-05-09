import { createHash } from "node:crypto";
import type { AgentRuntime, Character } from "@elizaos/core";
import { getStaticEmbeddingDimension } from "@/lib/cache/edge-runtime-cache";
import { DEFAULT_IMAGE_MODEL } from "@/lib/models";
import { buildElevenLabsSettings, getDefaultModels, getElizaCloudApiUrl } from "../config";
import type { UserContext } from "../user-context";
import { setMcpEnabledServers } from "./mcp-config";
import { stableSerialize } from "./stable-serialize";

export interface RuntimeSettings {
  ELIZAOS_API_KEY?: string;
  ELIZAOS_CLOUD_API_KEY?: string;
  USER_ID?: string;
  ENTITY_ID?: string;
  ORGANIZATION_ID?: string;
  IS_ANONYMOUS?: boolean;
  ELIZAOS_CLOUD_NANO_MODEL?: string;
  ELIZAOS_CLOUD_SMALL_MODEL?: string;
  ELIZAOS_CLOUD_MEDIUM_MODEL?: string;
  ELIZAOS_CLOUD_LARGE_MODEL?: string;
  ELIZAOS_CLOUD_MEGA_MODEL?: string;
  ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL?: string;
  ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL?: string;
  ELIZAOS_CLOUD_ACTION_PLANNER_MODEL?: string;
  ELIZAOS_CLOUD_PLANNER_MODEL?: string;
  ELIZAOS_CLOUD_RESPONSE_MODEL?: string;
  ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL?: string;
  ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL?: string;
  appPromptConfig?: unknown;
  [key: string]: unknown;
}

export function buildDirectAccessContextSignature(context: UserContext): string {
  const signatureSource = {
    modelPreferences: context.modelPreferences ?? null,
    imageModel: context.imageModel ?? null,
    appPromptConfig: context.appPromptConfig ?? null,
  };

  if (
    !signatureSource.modelPreferences &&
    !signatureSource.imageModel &&
    !signatureSource.appPromptConfig
  ) {
    return "";
  }

  return createHash("sha1").update(stableSerialize(signatureSource)).digest("hex").slice(0, 16);
}

export function buildRuntimeSettings(context: UserContext): Record<string, string | undefined> {
  const ephemeralSettings: Record<string, string | boolean | number | Record<string, unknown>> = {
    ELIZAOS_API_KEY: context.apiKey,
    ELIZAOS_CLOUD_API_KEY: context.apiKey,
    USER_ID: context.userId,
    ENTITY_ID: context.entityId,
    ORGANIZATION_ID: context.organizationId,
    IS_ANONYMOUS: context.isAnonymous,
  };

  return Object.fromEntries(
    Object.entries(ephemeralSettings).map(([key, value]) => [
      key,
      typeof value === "string"
        ? value
        : value === null || value === undefined
          ? undefined
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value),
    ]),
  );
}

export function buildSettings(
  character: Character,
  context: UserContext,
): NonNullable<Character["settings"]> {
  const {
    mcp: _stripMcp,
    ELIZAOS_API_KEY: _stripApiKey,
    ELIZAOS_CLOUD_API_KEY: _stripCloudApiKey,
    USER_ID: _stripUserId,
    ENTITY_ID: _stripEntityId,
    ORGANIZATION_ID: _stripOrgId,
    IS_ANONYMOUS: _stripIsAnon,
    ...charSettings
  } = (character.settings || {}) as Record<string, unknown>;

  const getSetting = (key: string, fallback: string) =>
    (charSettings[key] as string) || process.env[key] || fallback;

  const embeddingModel =
    (charSettings.OPENAI_EMBEDDING_MODEL as string) ||
    (charSettings.ELIZAOS_CLOUD_EMBEDDING_MODEL as string);
  const embeddingDimension = getStaticEmbeddingDimension(embeddingModel);

  return {
    ...charSettings,
    POSTGRES_URL: process.env.DATABASE_URL!,
    DATABASE_URL: process.env.DATABASE_URL!,
    EMBEDDING_DIMENSION: String(embeddingDimension),
    ELIZAOS_CLOUD_BASE_URL: getElizaCloudApiUrl(),
    ELIZAOS_CLOUD_NANO_MODEL:
      context.modelPreferences?.nanoModel ||
      getSetting(
        "ELIZAOS_CLOUD_NANO_MODEL",
        getSetting("ELIZAOS_CLOUD_SMALL_MODEL", getDefaultModels().small),
      ),
    ELIZAOS_CLOUD_MEDIUM_MODEL:
      context.modelPreferences?.mediumModel ||
      getSetting(
        "ELIZAOS_CLOUD_MEDIUM_MODEL",
        getSetting("ELIZAOS_CLOUD_SMALL_MODEL", getDefaultModels().small),
      ),
    ELIZAOS_CLOUD_SMALL_MODEL:
      context.modelPreferences?.smallModel ||
      getSetting("ELIZAOS_CLOUD_SMALL_MODEL", getDefaultModels().small),
    ELIZAOS_CLOUD_LARGE_MODEL:
      context.modelPreferences?.largeModel ||
      getSetting("ELIZAOS_CLOUD_LARGE_MODEL", getDefaultModels().large),
    ELIZAOS_CLOUD_MEGA_MODEL:
      context.modelPreferences?.megaModel ||
      getSetting(
        "ELIZAOS_CLOUD_MEGA_MODEL",
        getSetting("ELIZAOS_CLOUD_LARGE_MODEL", getDefaultModels().large),
      ),
    ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL:
      context.modelPreferences?.responseHandlerModel ||
      context.modelPreferences?.shouldRespondModel ||
      getSetting(
        "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
        getSetting(
          "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
          context.modelPreferences?.nanoModel ||
            context.modelPreferences?.smallModel ||
            getSetting("ELIZAOS_CLOUD_NANO_MODEL", getDefaultModels().small),
        ),
      ),
    ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL:
      context.modelPreferences?.shouldRespondModel ||
      context.modelPreferences?.responseHandlerModel ||
      getSetting(
        "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
        getSetting(
          "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
          context.modelPreferences?.nanoModel ||
            context.modelPreferences?.smallModel ||
            getSetting("ELIZAOS_CLOUD_NANO_MODEL", getDefaultModels().small),
        ),
      ),
    ELIZAOS_CLOUD_ACTION_PLANNER_MODEL:
      context.modelPreferences?.actionPlannerModel ||
      context.modelPreferences?.plannerModel ||
      getSetting(
        "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
        getSetting(
          "ELIZAOS_CLOUD_PLANNER_MODEL",
          context.modelPreferences?.mediumModel ||
            context.modelPreferences?.smallModel ||
            getSetting("ELIZAOS_CLOUD_MEDIUM_MODEL", getDefaultModels().small),
        ),
      ),
    ELIZAOS_CLOUD_PLANNER_MODEL:
      context.modelPreferences?.plannerModel ||
      context.modelPreferences?.actionPlannerModel ||
      getSetting(
        "ELIZAOS_CLOUD_PLANNER_MODEL",
        getSetting(
          "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
          context.modelPreferences?.mediumModel ||
            context.modelPreferences?.smallModel ||
            getSetting("ELIZAOS_CLOUD_SMALL_MODEL", getDefaultModels().small),
        ),
      ),
    ELIZAOS_CLOUD_RESPONSE_MODEL:
      context.modelPreferences?.responseModel ||
      getSetting(
        "ELIZAOS_CLOUD_RESPONSE_MODEL",
        context.modelPreferences?.largeModel ||
          getSetting("ELIZAOS_CLOUD_LARGE_MODEL", getDefaultModels().large),
      ),
    ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL:
      context.modelPreferences?.mediaDescriptionModel ||
      getSetting("ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL", "google/gemini-2.5-flash-lite"),
    ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL:
      context.imageModel ||
      getSetting("ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL", DEFAULT_IMAGE_MODEL.modelId),
    ...buildElevenLabsSettings(charSettings),
    ...(context.appPromptConfig ? { appPromptConfig: context.appPromptConfig } : {}),
    ...(context.webSearchEnabled
      ? {
          ...(process.env.GOOGLE_API_KEY ? { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY } : {}),
          ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}),
          ...(process.env.GOOGLE_GENERATIVE_AI_API_KEY
            ? { GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY }
            : {}),
        }
      : {}),
  } as unknown as NonNullable<Character["settings"]>;
}

export function applyUserContext(runtime: AgentRuntime, context: UserContext): void {
  const charSettings = (runtime.character.settings || {}) as RuntimeSettings;

  if (context.modelPreferences) {
    charSettings.ELIZAOS_CLOUD_NANO_MODEL =
      context.modelPreferences.nanoModel || charSettings.ELIZAOS_CLOUD_NANO_MODEL;
    charSettings.ELIZAOS_CLOUD_SMALL_MODEL =
      context.modelPreferences.smallModel || charSettings.ELIZAOS_CLOUD_SMALL_MODEL;
    charSettings.ELIZAOS_CLOUD_MEDIUM_MODEL =
      context.modelPreferences.mediumModel || charSettings.ELIZAOS_CLOUD_MEDIUM_MODEL;
    charSettings.ELIZAOS_CLOUD_LARGE_MODEL =
      context.modelPreferences.largeModel || charSettings.ELIZAOS_CLOUD_LARGE_MODEL;
    charSettings.ELIZAOS_CLOUD_MEGA_MODEL =
      context.modelPreferences.megaModel || charSettings.ELIZAOS_CLOUD_MEGA_MODEL;
    charSettings.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL =
      context.modelPreferences.responseHandlerModel ||
      context.modelPreferences.shouldRespondModel ||
      charSettings.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL;
    charSettings.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL =
      context.modelPreferences.shouldRespondModel ||
      context.modelPreferences.responseHandlerModel ||
      charSettings.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL;
    charSettings.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL =
      context.modelPreferences.actionPlannerModel ||
      context.modelPreferences.plannerModel ||
      charSettings.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL;
    charSettings.ELIZAOS_CLOUD_PLANNER_MODEL =
      context.modelPreferences.plannerModel ||
      context.modelPreferences.actionPlannerModel ||
      charSettings.ELIZAOS_CLOUD_PLANNER_MODEL;
    charSettings.ELIZAOS_CLOUD_RESPONSE_MODEL =
      context.modelPreferences.responseModel || charSettings.ELIZAOS_CLOUD_RESPONSE_MODEL;
    charSettings.ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL =
      context.modelPreferences.mediaDescriptionModel ||
      charSettings.ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL;
  }

  if (context.imageModel) {
    charSettings.ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL = context.imageModel;
  }

  if (context.appPromptConfig) {
    charSettings.appPromptConfig = context.appPromptConfig;
  }

  setMcpEnabledServers(context);
}
