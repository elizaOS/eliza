/**
 * Boots a fixed assistant/model runtime after local admission and durable audit
 * preparation. Signed route bindings supply model destinations, and an actual
 * attested embedding request is required before readiness. The measured entry
 * owns API exposure, encrypted storage and process network confinement.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  AgentRuntime,
  ElizaError,
  logger,
  type ModelParamsMap,
  ModelType,
  type Plugin,
  resolveAliasedEnvValue,
  type UUID,
} from "@elizaos/core";
import { z } from "zod";
import {
  confidentialHostConfiguration,
  createConfidentialHostPolicy,
} from "../security/confidential-host-policy.ts";
import { createConfidentialLocalAdmission } from "../security/confidential-local-admission.ts";
import { prepareConfidentialHost } from "./confidential-host-bootstrap.ts";

const textSlots = {
  TEXT_SMALL: "OPENAI_SMALL_MODEL",
  TEXT_LARGE: "OPENAI_LARGE_MODEL",
  TEXT_NANO: "OPENAI_NANO_MODEL",
  TEXT_MEDIUM: "OPENAI_MEDIUM_MODEL",
  TEXT_MEGA: "OPENAI_MEGA_MODEL",
  RESPONSE_HANDLER: "OPENAI_RESPONSE_HANDLER_MODEL",
  ACTION_PLANNER: "OPENAI_ACTION_PLANNER_MODEL",
} as const;

export const confidentialRuntimeConfiguration = z
  .object({
    schema: z.literal("eliza-confidential-runtime-v1"),
    host: confidentialHostConfiguration,
    textRouteId: z.string().min(1),
    embeddingRouteId: z.string().min(1),
    textCredentialPath: z.string().refine(isAbsolute),
    embeddingCredentialPath: z.string().refine(isAbsolute),
    // This is the storage width, not an assertion of model/weight provenance.
    embeddingDimensions: z.literal(384),
  })
  .strict();
export type ConfidentialRuntimeConfiguration = z.input<
  typeof confidentialRuntimeConfiguration
>;

function rejected(): ElizaError {
  return new ElizaError(
    "Confidential runtime requires complete approved model bindings",
    {
      code: "CONFIDENTIAL_RUNTIME_CONFIGURATION_REJECTED",
    },
  );
}

function requireModel<K extends keyof ModelParamsMap>(
  models: Plugin["models"],
  modelType: K,
): NonNullable<NonNullable<Plugin["models"]>[K]> {
  const handler = models?.[modelType];
  if (!handler) throw rejected();
  return handler;
}

async function credential(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!value || !/^[!-~]+$/.test(value)) throw rejected();
  return value;
}

/** Call from a measured entry; no request, character or DB field selects plugins. */
export async function startConfidentialRuntime(
  input: ConfidentialRuntimeConfiguration,
  localEnvironment: Readonly<Record<string, string | undefined>>,
) {
  const parsed = confidentialRuntimeConfiguration.safeParse(input);
  if (!parsed.success) throw rejected();
  const configuration = parsed.data;
  const env = Object.freeze({ ...localEnvironment });
  // Validate both authorities before importing optional provider/assistant code.
  const policy = createConfidentialHostPolicy(configuration.host);
  const admit = await createConfidentialLocalAdmission(env);
  if (
    process.env.ELIZA_MOCK_OPENAI_BASE !== undefined ||
    resolveAliasedEnvValue("ELIZA_STATE_DIR") !==
      configuration.host.stateDirectory ||
    (process.env.ELIZA_TRAJECTORY_DIR !== undefined &&
      process.env.ELIZA_TRAJECTORY_DIR !==
        join(configuration.host.stateDirectory, "trajectories"))
  )
    throw rejected();
  const routes = policy.currentProfile().routes;
  const text = routes.find((route) => route.id === configuration.textRouteId);
  const embedding = routes.find(
    (route) => route.id === configuration.embeddingRouteId,
  );
  if (
    !text ||
    !embedding ||
    !Object.keys(textSlots).every((slot) => text.modelTypes.includes(slot)) ||
    ![ModelType.TEXT_EMBEDDING, ModelType.TEXT_EMBEDDING_BATCH].every((slot) =>
      embedding.modelTypes.includes(slot),
    ) ||
    !text.endpoint.endsWith("/chat/completions") ||
    !embedding.endpoint.endsWith("/embeddings")
  )
    throw rejected();
  const textBase = text.endpoint.substring(
    0,
    text.endpoint.length - "/chat/completions".length,
  );
  const embeddingBase = embedding.endpoint.substring(
    0,
    embedding.endpoint.length - "/embeddings".length,
  );
  const textKey = await credential(configuration.textCredentialPath);
  const embeddingKey = await credential(configuration.embeddingCredentialPath);
  const [{ openaiPlugin }, { embeddingsPlugin }, { createAssistantPlugin }] =
    await Promise.all([
      import("@elizaos/plugin-openai"),
      import("@elizaos/plugin-embeddings"),
      import("@elizaos/plugin-assistant"),
    ]);
  const textModels = {
    [ModelType.TEXT_SMALL]: requireModel(
      openaiPlugin.models,
      ModelType.TEXT_SMALL,
    ),
    [ModelType.TEXT_LARGE]: requireModel(
      openaiPlugin.models,
      ModelType.TEXT_LARGE,
    ),
    [ModelType.TEXT_NANO]: requireModel(
      openaiPlugin.models,
      ModelType.TEXT_NANO,
    ),
    [ModelType.TEXT_MEDIUM]: requireModel(
      openaiPlugin.models,
      ModelType.TEXT_MEDIUM,
    ),
    [ModelType.TEXT_MEGA]: requireModel(
      openaiPlugin.models,
      ModelType.TEXT_MEGA,
    ),
    [ModelType.RESPONSE_HANDLER]: requireModel(
      openaiPlugin.models,
      ModelType.RESPONSE_HANDLER,
    ),
    [ModelType.ACTION_PLANNER]: requireModel(
      openaiPlugin.models,
      ModelType.ACTION_PLANNER,
    ),
  };
  const embeddingModels = {
    [ModelType.TEXT_EMBEDDING]: requireModel(
      embeddingsPlugin.models,
      ModelType.TEXT_EMBEDDING,
    ),
    [ModelType.TEXT_EMBEDDING_BATCH]: requireModel(
      embeddingsPlugin.models,
      ModelType.TEXT_EMBEDDING_BATCH,
    ),
  };
  const host = await prepareConfidentialHost({
    configuration: configuration.host,
    localEnvironment: env,
    handlers: [...Object.values(textModels), ...Object.values(embeddingModels)],
  });
  let runtime: AgentRuntime | undefined;
  try {
    runtime = new AgentRuntime({
      agentId: configuration.host.agentId as UUID,
      character: { ...configuration.host.character, plugins: [] },
      adapter: host.adapter,
      confidentialInference: host.authority,
      enableAutonomy: false,
      settings: {
        ELIZA_PROVIDER: "openai",
        OPENAI_API_KEY: textKey,
        OPENAI_BASE_URL: textBase,
        OPENAI_EXPERIMENTAL_TELEMETRY: "false",
        ...Object.fromEntries(
          Object.values(textSlots).map((setting) => [setting, text.model]),
        ),
        ELIZA_EMBEDDING_PROVIDER: "embeddings",
        EMBEDDING_BASE_URL: embeddingBase,
        EMBEDDING_MODEL: embedding.model,
        EMBEDDING_API_KEY: embeddingKey,
        EMBEDDING_DIMENSIONS: String(configuration.embeddingDimensions),
      },
      // Copy only reviewed handlers. Provider init, config, media, research,
      // preconnect events and embedding warmup are deliberately absent.
      plugins: [
        {
          name: "openai",
          description: "Admitted text inference",
          models: textModels,
        },
        {
          name: "embeddings",
          description: "Admitted embedding inference",
          models: embeddingModels,
        },
        createAssistantPlugin(),
      ],
    });
    await admit();
    await runtime.initialize();
    if (runtime.isEmbeddingGenerationDisabled()) throw rejected();
    await runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: "Confidential runtime embedding readiness check.",
    });
    await host.hostAdmission();
    const startedRuntime = runtime;
    return Object.freeze({
      runtime: startedRuntime,
      hostAdmission: host.hostAdmission,
      async stop(): Promise<void> {
        host.revokeAdmission();
        try {
          await startedRuntime.stop();
        } finally {
          await host.close();
        }
      },
    });
  } catch (error) {
    // error-policy:J2 A partial runtime never becomes an admitted ready host.
    host.revokeAdmission();
    try {
      if (runtime) await runtime.stop();
    } catch {
      // error-policy:J6 Failed startup cleanup cannot replace the primary failure.
      logger.warn("[ConfidentialRuntime] Runtime startup cleanup failed");
    }
    try {
      await host.close();
    } catch {
      // error-policy:J6 Preserve startup failure when SQLite teardown also fails.
      logger.warn("[ConfidentialRuntime] Host startup cleanup failed");
    }
    throw new ElizaError("Confidential runtime startup rejected", {
      code: "CONFIDENTIAL_RUNTIME_STARTUP_REJECTED",
      cause: error,
    });
  }
}
