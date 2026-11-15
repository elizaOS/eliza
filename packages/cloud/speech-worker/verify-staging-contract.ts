/** Read-only source checks for the staging speech host; never invokes Cloudflare. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface WorkerConfig {
  name?: string;
  main?: string;
  account_id?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  workers_dev?: boolean;
  preview_urls?: boolean;
  routes?: unknown[];
  migrations?: unknown[];
  durable_objects?: { bindings?: Record<string, unknown>[] };
  exports?: Record<string, Record<string, unknown>>;
  vars?: Record<string, unknown>;
  define?: Record<string, string>;
  alias?: Record<string, string>;
  hyperdrive?: { binding: string; id: string }[];
  kv_namespaces?: { binding: string; id: string }[];
  r2_buckets?: unknown[];
  services?: unknown[];
  triggers?: unknown;
  env?: Record<string, WorkerConfig>;
}

export const SPEECH_WORKER_NAME = "eliza-cloud-speech-staging";
export const API_STAGING_NAME = "eliza-cloud-api-staging";
export const ADMISSION_STAGING_NAME = "eliza-cloud-admission-staging";

/** Secret names the coordinator reads. Names only; values are never read here. */
export const SPEECH_WORKER_REQUIRED_SECRETS = [
  "CARTESIA_API_KEY",
  "CARTESIA_STT_USD_PER_CREDIT",
  "DATABASE_URL",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
] as const;

/** Modules on the coordinator's bootstrap, admission, usage and fence path. */
export const COORDINATOR_SOURCES = [
  "api/src/speech-relay-coordinator.ts",
  "api/src/speech-relay-admission.ts",
  "api/src/speech-retirement-state.ts",
  "api/src/speech-revocation-subscription.ts",
  "api/v1/voice/session/lib/provider-socket-factory.ts",
  "api/v1/voice/stt/cartesia-pricing.ts",
  "api/v1/voice/tts/provider-selection.ts",
  "shared/src/lib/services/organization-inference-admission.ts",
  "shared/src/lib/services/inference-admission-gate.ts",
  "shared/src/lib/services/inference-billing-fast-path.ts",
  "shared/src/lib/services/voice-usage-meter.ts",
  "shared/src/lib/voice-session/config.ts",
  "shared/src/lib/cache/client.ts",
  "shared/src/lib/cache/redis-factory.ts",
] as const;

export interface SpeechWorkerContractInput {
  /** packages/cloud/api/wrangler.toml */
  source: WorkerConfig;
  /** packages/cloud/speech-worker/wrangler.toml */
  target: WorkerConfig;
  /** packages/cloud/admission-worker/wrangler.toml */
  admission: WorkerConfig;
  /** packages/cloud/speech-worker/src/index.ts */
  entry: string;
  /** Uppercase environment bindings read on the coordinator path. */
  coordinatorVariables: Set<string>;
  /** Base URLs used to resolve aliases to absolute files. */
  targetBase: URL;
  sourceBase: URL;
}

function sortedEntries<T>(values: Record<string, T> | undefined) {
  return Object.entries(values ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function resolvedAliases(
  values: Record<string, string> | undefined,
  base: URL,
) {
  return sortedEntries(values).map(([name, value]) => [
    name,
    fileURLToPath(new URL(value, base)),
  ]);
}

const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Returns every violated rule; an empty list means the contract holds. */
export function checkSpeechWorkerContract(
  input: SpeechWorkerContractInput,
): string[] {
  const { source, target, admission, entry } = input;
  const errors: string[] = [];
  const check = (condition: unknown, message: string) => {
    if (!condition) errors.push(message);
  };
  const stage = source.env?.staging;
  const production = source.env?.production;
  if (!stage) return ["Source must declare the staging API environment"];

  // Identity and isolation.
  check(
    stage.name === API_STAGING_NAME,
    "Source must remain the canonical staging API Worker",
  );
  check(
    target.name === SPEECH_WORKER_NAME,
    "Speech host must remain staging-only",
  );
  check(
    target.account_id === source.account_id,
    "Speech host account must match the API",
  );
  check(
    target.workers_dev === false && target.preview_urls === false,
    "No public preview",
  );
  check(!target.routes?.length, "Speech host must have no public routes");
  check(!target.triggers, "Speech host must have no cron triggers");
  check(!target.r2_buckets?.length, "Speech host must not bind blob storage");
  check(!target.services?.length, "Speech host must not bind services");

  // Build parity with the canonical staging API.
  check(
    target.compatibility_date ===
      (stage.compatibility_date ?? source.compatibility_date),
    "Compatibility date drift",
  );
  check(
    same(
      target.compatibility_flags,
      stage.compatibility_flags ?? source.compatibility_flags,
    ),
    "Compatibility flag drift",
  );
  check(
    same(
      sortedEntries(target.define),
      sortedEntries(stage.define ?? source.define),
    ),
    "Build defines must exactly match canonical staging",
  );
  check(
    same(
      resolvedAliases(target.alias, input.targetBase),
      resolvedAliases(stage.alias ?? source.alias, input.sourceBase),
    ),
    "Build aliases must resolve to the exact canonical staging map, without extra aliases",
  );

  // Durable Object lifecycle: one fresh SQLite namespace, declarative only.
  check(
    !target.migrations,
    "Declarative exports cannot mix with legacy migrations",
  );
  check(
    same(target.exports, {
      SpeechRelayCoordinator: { type: "durable-object", storage: "sqlite" },
    }),
    "Target must declare exactly one live SQLite SpeechRelayCoordinator export",
  );
  // The API keeps its own namespace so pre-switch objects finish retirement.
  check(
    same(sortedEntries(stage.exports?.SpeechRelayCoordinator), [
      ["storage", "sqlite"],
      ["type", "durable-object"],
    ]),
    "Staging API must keep exporting its SpeechRelayCoordinator namespace (no transfer, no deletion)",
  );
  check(
    same(sortedEntries(source.exports?.SpeechRelayCoordinator), [
      ["storage", "sqlite"],
      ["type", "durable-object"],
    ]),
    "Global API SpeechRelayCoordinator declaration must remain",
  );
  check(
    entry.includes(
      'export { SpeechRelayCoordinator } from "../../api/src/speech-relay-coordinator";',
    ),
    "Entry must reuse the canonical speech coordinator class",
  );

  // Bindings: self, admission namespace, API voice usage. Nothing else.
  check(
    same(target.durable_objects?.bindings, [
      { name: "SPEECH_RELAY_SESSIONS", class_name: "SpeechRelayCoordinator" },
      {
        name: "INFERENCE_ADMISSION_GATES",
        class_name: "InferenceAdmissionGate",
        script_name: admission.name,
      },
      {
        name: "VOICE_USAGE_STATE",
        class_name: "VoiceUsageState",
        script_name: stage.name,
      },
    ]),
    "Target Durable Object bindings must be the self-binding, the adopted admission gate and API voice usage",
  );
  check(admission.name === ADMISSION_STAGING_NAME, "Admission host name drift");
  const stageGate = stage.durable_objects?.bindings?.find(
    (binding) => binding.name === "INFERENCE_ADMISSION_GATES",
  );
  check(
    stageGate?.script_name === admission.name,
    "Speech host must use the same admission namespace as the staging API",
  );
  const stageSpeech = stage.durable_objects?.bindings?.filter(
    (binding) => binding.name === "SPEECH_RELAY_SESSIONS",
  );
  check(
    same(stageSpeech, [
      { name: "SPEECH_RELAY_SESSIONS", class_name: "SpeechRelayCoordinator" },
    ]) ||
      same(stageSpeech, [
        {
          name: "SPEECH_RELAY_SESSIONS",
          class_name: "SpeechRelayCoordinator",
          script_name: target.name,
        },
      ]),
    "Staging API speech binding must use the API or lean speech host",
  );
  // Production keeps its current hosting until staging proves the move.
  const productionSpeech = production?.durable_objects?.bindings?.filter(
    (binding) => binding.name === "SPEECH_RELAY_SESSIONS",
  );
  check(
    same(productionSpeech, [
      { name: "SPEECH_RELAY_SESSIONS", class_name: "SpeechRelayCoordinator" },
    ]),
    "Production speech binding must stay on the production API Worker",
  );

  // Resources are reused, never new.
  check(
    same(
      target.hyperdrive,
      stage.hyperdrive?.filter((item) => item.binding === "HYPERDRIVE"),
    ) && target.hyperdrive?.length === 1,
    "Hyperdrive must reuse exactly the staging HYPERDRIVE resource",
  );
  check(
    same(
      target.kv_namespaces,
      stage.kv_namespaces?.filter((item) => item.binding === "CACHE_KV"),
    ) && target.kv_namespaces?.length === 1,
    "KV must reuse exactly the staging CACHE_KV resource",
  );

  // Configuration parity. A missing or different flag is a silent split.
  for (const [key, value] of Object.entries(target.vars ?? {}))
    check(
      stage.vars?.[key] === value,
      `Target variable differs from staging: ${key}`,
    );
  for (const key of Object.keys(admission.vars ?? {}))
    check(
      target.vars?.[key] === stage.vars?.[key],
      `Admission variable must also match on the speech host: ${key}`,
    );
  check(
    input.coordinatorVariables.has("VOICE_SPEECH_RELAY_ENABLED") &&
      input.coordinatorVariables.has("CARTESIA_API_KEY"),
    "Coordinator variable scan no longer finds the speech flag and provider key",
  );
  for (const key of input.coordinatorVariables) {
    if (stage.vars?.[key] === undefined) continue;
    check(
      target.vars?.[key] === stage.vars[key],
      `Coordinator variable must match staging: ${key}`,
    );
  }
  for (const key of SPEECH_WORKER_REQUIRED_SECRETS)
    check(
      target.vars?.[key] === undefined,
      `Secret must not be a plain-text variable: ${key}`,
    );
  check(
    target.vars?.INFERENCE_FUNDED_BUDGET_ADMISSION ===
      stage.vars?.INFERENCE_FUNDED_BUDGET_ADMISSION,
    "Funded admission effective configuration must not change",
  );
  return errors;
}

export async function scanCoordinatorVariables(
  base: URL,
): Promise<Set<string>> {
  const names = new Set([
    // The Redis factory reads this selector through an alias for env.
    "DIRECT_REDIS_BACKEND",
    // resolveVoiceUsageLimits uses optional chaining. Other optional reads in
    // the same module belong to API-only voice paths.
    "VOICE_REALTIME_ORG_DAILY_MINUTES",
    "VOICE_REALTIME_USER_DAILY_MINUTES",
  ]);
  for (const file of COORDINATOR_SOURCES) {
    const text = await readFile(new URL(file, base), "utf8");
    for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g))
      if (match[1]) names.add(match[1]);
  }
  return names;
}

export async function loadSpeechWorkerContractInput(): Promise<SpeechWorkerContractInput> {
  const cloud = new URL("../", import.meta.url);
  const parse = async (path: string) =>
    Bun.TOML.parse(
      await readFile(new URL(path, cloud), "utf8"),
    ) as WorkerConfig;
  return {
    source: await parse("api/wrangler.toml"),
    target: await parse("speech-worker/wrangler.toml"),
    admission: await parse("admission-worker/wrangler.toml"),
    entry: await readFile(new URL("speech-worker/src/index.ts", cloud), "utf8"),
    coordinatorVariables: await scanCoordinatorVariables(cloud),
    targetBase: new URL("speech-worker/", cloud),
    sourceBase: new URL("api/", cloud),
  };
}

if (import.meta.main) {
  if (process.argv.includes("--required-secret-names")) {
    console.log(SPEECH_WORKER_REQUIRED_SECRETS.join(" "));
  } else {
    const input = await loadSpeechWorkerContractInput();
    const errors = checkSpeechWorkerContract(input);
    if (errors.length) {
      for (const error of errors) console.error(`::error::${error}`);
      process.exit(1);
    }
    if (process.argv.includes("--selected-host")) {
      const binding =
        input.source.env?.staging?.durable_objects?.bindings?.find(
          (item) => item.name === "SPEECH_RELAY_SESSIONS",
        );
      if (!binding)
        throw new Error("Validated staging speech binding is missing");
      console.log(
        binding.script_name === SPEECH_WORKER_NAME ? "speech" : "api",
      );
    } else {
      console.log(
        "Speech host staging source contract passed; live secrets, namespace and latency require separate receipts.",
      );
    }
  }
}
