/** Read-only source checks for the accepted staging topology; never invokes Cloudflare. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface WorkerConfig {
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
  services?: { binding: string; service: string; entrypoint?: string }[];
  env?: Record<string, WorkerConfig>;
}

function requireContract(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

const source = Bun.TOML.parse(
  await readFile(new URL("../api/wrangler.toml", import.meta.url), "utf8"),
) as WorkerConfig;
const target = Bun.TOML.parse(
  await readFile(new URL("./wrangler.toml", import.meta.url), "utf8"),
) as WorkerConfig;
const stage = source.env?.staging;
requireContract(
  stage?.name === "eliza-cloud-api-staging",
  "Source must remain the canonical staging API Worker",
);
requireContract(
  target.account_id === source.account_id,
  "Transfer account must match source",
);
requireContract(
  target.compatibility_date ===
    (stage.compatibility_date ?? source.compatibility_date),
  "Compatibility date drift",
);
requireContract(
  JSON.stringify(target.compatibility_flags) ===
    JSON.stringify(stage.compatibility_flags ?? source.compatibility_flags),
  "Compatibility flag drift",
);
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

requireContract(
  JSON.stringify(sortedEntries(target.define)) ===
    JSON.stringify(sortedEntries(stage.define ?? source.define)),
  "Build defines must exactly match canonical staging",
);
requireContract(
  JSON.stringify(
    resolvedAliases(
      Object.fromEntries(
        Object.entries(target.alias ?? {}).filter(
          ([name]) =>
            name !==
            "@elizaos/cloud-shared/lib/services/inference-admission-recovery",
        ),
      ),
      new URL("./", import.meta.url),
    ),
  ) ===
    JSON.stringify(
      resolvedAliases(
        stage.alias ?? source.alias,
        new URL("../api/", import.meta.url),
      ),
    ),
  "Build aliases must resolve to the exact canonical staging map, without extra aliases",
);
requireContract(
  !target.migrations,
  "Declarative exports cannot mix with legacy migrations",
);
requireContract(
  target.workers_dev === false && target.preview_urls === false,
  "No public preview",
);
requireContract(
  !target.routes?.length,
  "Admission Worker must have no public routes",
);
requireContract(
  JSON.stringify(stage.migrations) === "[]",
  "Accepted staging must explicitly disable inherited legacy migrations",
);
const expectedClasses = [
  "SharedRuntimeConversation",
  "InferenceAdmissionGate",
  "AnonymousChatGate",
  "OnboardingSessionCoordinator",
  "TwitterOAuthRefreshCoordinator",
  "PersonalDeliveryProjection",
  "PersonalTelegramDelivery",
  "InferenceRateLimitV2RollbackFloor",
  "DoorDashCheckoutGate",
].sort();
requireContract(
  JSON.stringify(Object.keys(stage.exports ?? {}).sort()) ===
    JSON.stringify(expectedClasses),
  "Staging must retain exactly all nine source declarations",
);
for (const name of expectedClasses) {
  const globalDeclaration = source.exports?.[name];
  requireContract(
    globalDeclaration?.type === "durable-object" &&
      globalDeclaration.storage === "sqlite",
    `Global source SQLite declaration must remain: ${name}`,
  );
  const expected =
    name === "InferenceAdmissionGate"
      ? {
          type: "durable-object",
          state: "transferred",
          transferred_to: target.name,
        }
      : globalDeclaration;
  requireContract(
    JSON.stringify(sortedEntries(stage.exports?.[name])) ===
      JSON.stringify(sortedEntries(expected)),
    `Accepted staging declaration drift: ${name}`,
  );
}
requireContract(
  JSON.stringify(target.exports) ===
    JSON.stringify({
      InferenceAdmissionGate: { type: "durable-object", storage: "sqlite" },
    }),
  "Target must retain exactly one live SQLite export without transfer state",
);
requireContract(
  target.name === "eliza-cloud-admission-staging",
  "Admission target must remain staging-only",
);
requireContract(
  JSON.stringify(target.durable_objects?.bindings) ===
    JSON.stringify([
      {
        name: "INFERENCE_ADMISSION_GATES",
        class_name: "InferenceAdmissionGate",
      },
    ]),
  "Accepted target must have exactly one local admission self-binding",
);
const sourceGateBindings = stage.durable_objects?.bindings?.filter(
  (binding) => binding.name === "INFERENCE_ADMISSION_GATES",
);
requireContract(
  JSON.stringify(sourceGateBindings) ===
    JSON.stringify([
      {
        name: "INFERENCE_ADMISSION_GATES",
        class_name: "InferenceAdmissionGate",
        script_name: target.name,
      },
    ]),
  "Staging API admission binding must reference the adopted target",
);
for (const [key, value] of Object.entries(target.vars ?? {})) {
  requireContract(
    stage.vars?.[key] === value,
    `Target variable differs from staging: ${key}`,
  );
}
for (const key of ["CACHE_BACKEND", "CACHE_ENABLED", "NEXT_PUBLIC_APP_URL"]) {
  requireContract(
    target.vars?.[key] !== undefined && target.vars[key] === stage.vars?.[key],
    `Recovery configuration must retain staging variable: ${key}`,
  );
}
requireContract(
  target.vars?.INFERENCE_FUNDED_BUDGET_ADMISSION ===
    stage.vars?.INFERENCE_FUNDED_BUDGET_ADMISSION,
  "Funded admission effective configuration must not change",
);
for (const binding of target.hyperdrive ?? []) {
  requireContract(
    stage.hyperdrive?.some(
      (item) => item.binding === binding.binding && item.id === binding.id,
    ),
    "Hyperdrive must reuse staging resource",
  );
}
for (const binding of target.kv_namespaces ?? []) {
  requireContract(
    stage.kv_namespaces?.some(
      (item) => item.binding === binding.binding && item.id === binding.id,
    ),
    "KV must reuse staging resource",
  );
}
const entry = await readFile(
  new URL("./src/index.ts", import.meta.url),
  "utf8",
);
requireContract(
  entry.includes(
    'export { InferenceAdmissionGate } from "../../api/src/inference-admission-gate";',
  ),
  "Entry must reuse canonical admission class",
);
requireContract(
  target.alias?.[
    "@elizaos/cloud-shared/lib/services/inference-admission-recovery"
  ] === "./src/recovery-service.ts",
  "Recovery must use the private RPC adapter",
);
requireContract(
  JSON.stringify(target.services) ===
    JSON.stringify([
      {
        binding: "INFERENCE_RECOVERY_SERVICE",
        service: stage.name,
        entrypoint: "InferenceRecoveryService",
      },
    ]),
  "Recovery must remain on the source API capability",
);
requireContract(
  !target.hyperdrive?.length && !target.kv_namespaces?.length,
  "Target must not own database or cache credentials",
);

console.log(
  "Admission staging steady-state source contract passed; live namespace and secret parity require separate receipts.",
);
