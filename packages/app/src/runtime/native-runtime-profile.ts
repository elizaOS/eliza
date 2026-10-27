/**
 * Declarative runtime profiles for an on-device resident agent whose text
 * inference is bound to Eliza Cloud. Every mobile host selects one profile
 * with ELIZA_RUNTIME_PROFILE; this module is the single routing writer, so a
 * branded host supplies only its admitted Cloud API base, never its own
 * routing implementation.
 *
 * - `native` (default): Cloud text inference; embeddings, transcription and
 *   speech stay on the device through libelizainference. Missing local
 *   embedding inputs surface as unavailable, never as a silent Cloud fallback.
 * - `cloud`: an explicit QA profile without local model payloads; embeddings
 *   use authenticated Eliza Cloud. Its speech is a separately disclosed host
 *   upload, so the agent's own speech routing stays local-only in both.
 *
 * Both run the agent on the phone, so schedules run only while it is powered
 * on: a late scheduled occurrence is recorded once as missed, never replayed.
 */
import type { ServiceRouteConfig } from "@elizaos/contracts";
import { buildElizaCloudServiceRoute } from "@elizaos/host/protocol";
import type { RoutingPreferences } from "@elizaos/plugin-native-inference/model-catalog/routing-preferences";

export type NativeRuntimeProfileId = "native" | "cloud";

export interface NativeRuntimeProfile {
  readonly id: NativeRuntimeProfileId;
  readonly textInference: "elizacloud";
  readonly embeddings: "local" | "elizacloud";
  readonly agentSpeech: "local-only";
  /** Whether the host packages local model inputs (BGE, ASR, TTS, VAD). */
  readonly localModels: boolean;
  /** Late scheduled workflow occurrences are recorded, not run. */
  readonly missedOccurrences: "record";
}

export const NATIVE_RUNTIME_PROFILES: Readonly<
  Record<NativeRuntimeProfileId, NativeRuntimeProfile>
> = Object.freeze({
  native: Object.freeze({
    id: "native",
    textInference: "elizacloud",
    embeddings: "local",
    agentSpeech: "local-only",
    localModels: true,
    missedOccurrences: "record",
  }),
  cloud: Object.freeze({
    id: "cloud",
    textInference: "elizacloud",
    embeddings: "elizacloud",
    agentSpeech: "local-only",
    localModels: false,
    missedOccurrences: "record",
  }),
});

/** An absent selection is the native profile; anything unknown fails closed. */
export function resolveNativeRuntimeProfile(
  value: string | undefined,
): NativeRuntimeProfile {
  if (value === undefined || value === "" || value === "native")
    return NATIVE_RUNTIME_PROFILES.native;
  if (value === "cloud") return NATIVE_RUNTIME_PROFILES.cloud;
  throw new Error("Unknown native runtime profile");
}

/** Read by the workflow service; see plugin-workflow recordsMissedOccurrences. */
export const MISSED_OCCURRENCES_ENV = "ELIZA_WORKFLOW_MISSED_OCCURRENCES";

/**
 * Applies the profile's process-wide policy at every resident boot, signed in
 * or not. A host that selects no profile keeps its existing behavior.
 */
export function applyNativeRuntimeProfileEnvironment(
  env: NodeJS.ProcessEnv,
): NativeRuntimeProfile | undefined {
  if (env.ELIZA_RUNTIME_PROFILE === undefined) return undefined;
  const profile = resolveNativeRuntimeProfile(env.ELIZA_RUNTIME_PROFILE);
  env[MISSED_OCCURRENCES_ENV] = profile.missedOccurrences;
  return profile;
}

export const LOCAL_EMBEDDING_ROUTE: ServiceRouteConfig = Object.freeze({
  backend: "eliza-local-inference",
  transport: "direct",
});

/** Canonical service routes for a Cloud-bound resident. */
export function nativeCloudServiceRouting(
  profile: NativeRuntimeProfile,
  models: { small: string; large: string },
): { embeddings: ServiceRouteConfig; llmText: ServiceRouteConfig } {
  return {
    embeddings:
      profile.embeddings === "elizacloud"
        ? buildElizaCloudServiceRoute()
        : { ...LOCAL_EMBEDDING_ROUTE },
    llmText: buildElizaCloudServiceRoute({
      nanoModel: models.small,
      smallModel: models.small,
      mediumModel: models.small,
      largeModel: models.large,
      megaModel: models.large,
      responseHandlerModel: models.small,
      actionPlannerModel: models.large,
    }),
  };
}

/** Pins text slots to Cloud and agent speech to the device; other slots keep the owner's choice. */
export function nativeRuntimeRoutingPreferences(
  profile: NativeRuntimeProfile,
  current: RoutingPreferences,
): RoutingPreferences {
  return {
    preferredProvider: {
      ...current.preferredProvider,
      TEXT_SMALL: profile.textInference,
      TEXT_LARGE: profile.textInference,
    },
    policy: {
      ...current.policy,
      TEXT_SMALL: "manual",
      TEXT_LARGE: "manual",
      TRANSCRIPTION: profile.agentSpeech,
      TEXT_TO_SPEECH: profile.agentSpeech,
    },
  };
}

/** Product input from the host's admitted resources: its Cloud deployment only. */
export interface NativeCloudRuntimeDeclaration {
  readonly apiBaseUrl: string;
}

export function parseNativeCloudRuntimeDeclaration(
  value: unknown,
): NativeCloudRuntimeDeclaration {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Native Cloud runtime declaration is invalid");
  const { apiBaseUrl, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof apiBaseUrl !== "string")
    throw new Error("Native Cloud runtime declaration is invalid");
  let url: URL;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    throw new Error("Native Cloud runtime declaration is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/v1" ||
    url.href !== `${url.origin}/api/v1`
  )
    throw new Error("Native Cloud runtime declaration is invalid");
  return Object.freeze({ apiBaseUrl: url.href });
}

type ElizaConfigLike = {
  cloud?: Record<string, unknown>;
  serviceRouting?: Record<string, unknown>;
};

export interface NativeRuntimeProfileStores {
  loadConfig(): ElizaConfigLike;
  saveConfig(config: ElizaConfigLike): void;
  updateRoutingPreferences(
    update: (current: RoutingPreferences) => RoutingPreferences,
  ): Promise<unknown>;
}

async function defaultStores(): Promise<NativeRuntimeProfileStores> {
  const [{ loadElizaConfig, saveElizaConfig }, { updateRoutingPreferences }] =
    await Promise.all([
      import("@elizaos/agent/config/config"),
      import(
        "@elizaos/plugin-native-inference/model-catalog/routing-preferences"
      ),
    ]);
  return {
    loadConfig: () => loadElizaConfig() as ElizaConfigLike,
    saveConfig: (config) =>
      saveElizaConfig(config as Parameters<typeof saveElizaConfig>[0]),
    updateRoutingPreferences,
  };
}

/**
 * Projects the admitted Cloud binding into canonical runtime configuration
 * before boot. The protected native store keeps the credential; only routing
 * is written, and a stored desktop-style key cannot shadow the native one.
 * The profile's embedding authority is persisted even when local inputs are
 * absent, so an earlier Cloud QA route cannot send native memory off-device.
 */
export async function applyNativeCloudRuntimeProfile(
  env: NodeJS.ProcessEnv,
  declaration: NativeCloudRuntimeDeclaration,
  stores?: NativeRuntimeProfileStores,
): Promise<NativeRuntimeProfile> {
  const profile = resolveNativeRuntimeProfile(env.ELIZA_RUNTIME_PROFILE);
  const { apiBaseUrl } = parseNativeCloudRuntimeDeclaration(declaration);
  const small = env.ELIZAOS_CLOUD_SMALL_MODEL;
  const large = env.ELIZAOS_CLOUD_LARGE_MODEL;
  if (!small || !large || env.ELIZAOS_CLOUD_BASE_URL !== apiBaseUrl)
    throw new Error("Native Cloud inference binding is incomplete");
  const store = stores ?? (await defaultStores());
  const config = store.loadConfig();
  const { apiKey: _desktopKey, ...cloud } = config.cloud ?? {};
  config.cloud = { ...cloud, enabled: true, baseUrl: apiBaseUrl };
  config.serviceRouting = {
    ...config.serviceRouting,
    ...nativeCloudServiceRouting(profile, { small, large }),
  };
  store.saveConfig(config);
  await store.updateRoutingPreferences((current) =>
    nativeRuntimeRoutingPreferences(profile, current),
  );
  return profile;
}
