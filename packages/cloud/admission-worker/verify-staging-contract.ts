/** Read-only source checks for the admission topology; never invokes Cloudflare. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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

// Staging checks the accepted steady state. Production checks whichever
// same-namespace transfer phase is committed; `--phase` pins the expected one.
const { values: options } = parseArgs({
  options: {
    production: { type: "boolean", default: false },
    phase: { type: "string" },
  },
});
const environment = options.production ? "production" : "staging";
const names = {
  staging: {
    source: "eliza-cloud-api-staging",
    target: "eliza-cloud-admission-staging",
  },
  production: {
    source: "eliza-cloud-api-prod",
    target: "eliza-cloud-admission-prod",
  },
}[environment];

// Wrangler inherits these keys into an environment. Vars, defines, bindings
// and services belong to the environment alone; aliases only to the top level.
const inheritedKeys = [
  "main",
  "account_id",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "preview_urls",
  "routes",
  "migrations",
  "exports",
] as const;
function environmentConfig(config: WorkerConfig, name: string) {
  const scoped = config.env?.[name];
  return (
    scoped &&
    ({
      ...Object.fromEntries(inheritedKeys.map((key) => [key, config[key]])),
      ...scoped,
    } as WorkerConfig)
  );
}

const source = Bun.TOML.parse(
  await readFile(new URL("../api/wrangler.toml", import.meta.url), "utf8"),
) as WorkerConfig;
const admission = Bun.TOML.parse(
  await readFile(new URL("./wrangler.toml", import.meta.url), "utf8"),
) as WorkerConfig;
const stage = environmentConfig(source, environment);
const target =
  environment === "staging"
    ? admission
    : environmentConfig(admission, environment);
requireContract(
  stage?.name === names.source,
  `Source must remain the canonical ${environment} API Worker`,
);
requireContract(target, `Admission ${environment} target is not configured`);
requireContract(
  target.account_id === source.account_id,
  "Transfer account must match source",
);
requireContract(
  target.compatibility_date === stage.compatibility_date,
  "Compatibility date drift",
);
requireContract(
  JSON.stringify(target.compatibility_flags) ===
    JSON.stringify(stage.compatibility_flags),
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
    JSON.stringify(sortedEntries(stage.define)),
  `Build defines must exactly match canonical ${environment}`,
);
requireContract(
  JSON.stringify(
    resolvedAliases(
      Object.fromEntries(
        Object.entries(admission.alias ?? {}).filter(
          ([name]) =>
            name !==
            "@elizaos/cloud-shared/lib/services/inference-admission-recovery",
        ),
      ),
      new URL("./", import.meta.url),
    ),
  ) ===
    JSON.stringify(
      resolvedAliases(source.alias, new URL("../api/", import.meta.url)),
    ),
  `Build aliases must resolve to the exact canonical ${environment} map, without extra aliases`,
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
// An environment exports map replaces the global one, so it must also stop
// any legacy migrations from being inherited beside it.
requireContract(
  source.env?.[environment]?.exports
    ? JSON.stringify(stage.migrations) === "[]"
    : !stage.migrations?.length,
  `Accepted ${environment} must explicitly disable inherited legacy migrations`,
);
// Every global SQLite class stays declared; only the admission gate moves.
// Derived from the source so new classes cannot go stale here.
const gate = "InferenceAdmissionGate";
const expectedClasses = Object.keys(source.exports ?? {}).sort();
requireContract(
  expectedClasses.includes(gate),
  "Global source must declare the admission gate",
);
requireContract(
  JSON.stringify(Object.keys(stage.exports ?? {}).sort()) ===
    JSON.stringify(expectedClasses),
  `Accepted ${environment} must retain exactly every global source declaration`,
);
for (const name of expectedClasses) {
  const globalDeclaration = source.exports?.[name];
  requireContract(
    globalDeclaration?.type === "durable-object" &&
      globalDeclaration.storage === "sqlite",
    `Global source SQLite declaration must remain: ${name}`,
  );
  requireContract(
    name === gate ||
      JSON.stringify(sortedEntries(stage.exports?.[name])) ===
        JSON.stringify(sortedEntries(globalDeclaration)),
    `Accepted ${environment} declaration drift: ${name}`,
  );
}
for (const binding of stage.durable_objects?.bindings ?? []) {
  requireContract(
    binding.name === "INFERENCE_ADMISSION_GATES" ||
      (binding.class_name !== gate && !binding.script_name),
    `Only the admission binding may leave the ${environment} API: ${binding.name}`,
  );
}

// Each committed state is one legal step of the same-namespace transfer or of
// its reverse. Any other pairing could create a second namespace or strand the
// existing one, so it is rejected before Wrangler sees it. Staging has only
// its accepted steady state.
const live = { type: "durable-object", storage: "sqlite" };
const expecting = (from: string) => ({
  type: "durable-object",
  state: "expecting-transfer",
  storage: "sqlite",
  transfer_from: from,
});
const transferred = (to: string) => ({
  type: "durable-object",
  state: "transferred",
  transferred_to: to,
});
const local = { name: "INFERENCE_ADMISSION_GATES", class_name: gate };
const remote = (script: string) => ({ ...local, script_name: script });
const phases = {
  "target-pending": [expecting(names.source), [], live, [local]],
  "source-commit": [
    expecting(names.source),
    [],
    transferred(names.target),
    [remote(names.target)],
  ],
  adopted: [live, [local], transferred(names.target), [remote(names.target)]],
  "reverse-pending": [
    live,
    [local],
    expecting(names.target),
    [remote(names.target)],
  ],
  "reverse-commit": [
    transferred(names.source),
    [],
    expecting(names.target),
    [remote(names.target)],
  ],
  "reverse-adopted": [transferred(names.source), [], live, [local]],
};
// Canonical key order: TOML tables compare by content, binding lists by order.
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(sortedEntries(item))
      : item,
  );
const observed = canonical([
  target.exports?.[gate],
  target.durable_objects?.bindings ?? [],
  stage.exports?.[gate],
  stage.durable_objects?.bindings?.filter(
    (binding) => binding.name === local.name,
  ),
]);
const phase = Object.entries(phases).find(
  ([name, shape]) =>
    (environment === "production" || name === "adopted") &&
    canonical(shape) === observed,
)?.[0];
requireContract(
  phase,
  `Accepted ${environment} admission topology is not a legal transfer phase: ${observed}`,
);
requireContract(
  !options.phase || options.phase === phase,
  `Expected ${environment} admission phase ${options.phase}, found ${phase}`,
);
requireContract(
  JSON.stringify(Object.keys(target.exports ?? {})) === JSON.stringify([gate]),
  "Target must declare only the admission gate",
);
requireContract(
  target.name === names.target,
  `Admission target must remain ${environment}-only`,
);
for (const [key, value] of Object.entries(target.vars ?? {})) {
  requireContract(
    stage.vars?.[key] === value,
    `Target variable differs from ${environment}: ${key}`,
  );
}
// Production copies the accepted staging variable names, never their values.
requireContract(
  environment === "staging" ||
    JSON.stringify(Object.keys(target.vars ?? {}).sort()) ===
      JSON.stringify(Object.keys(admission.vars ?? {}).sort()),
  "Production target must carry exactly the accepted staging variable names",
);
for (const key of ["CACHE_BACKEND", "CACHE_ENABLED", "NEXT_PUBLIC_APP_URL"]) {
  requireContract(
    target.vars?.[key] !== undefined && target.vars[key] === stage.vars?.[key],
    `Recovery configuration must retain ${environment} variable: ${key}`,
  );
}
// The API keeps its own copy of these flags, so a missing target variable is a
// silent feature split (for example, speech subscriptions answering 404 while
// the API opens sessions). Compare every variable the gate's modules read.
const gateSources = [
  "inference-admission-gate.ts",
  "inference-funded-budget-controller.ts",
  "speech-revocation-registry.ts",
];
const gateVariables = new Set<string>();
for (const file of gateSources) {
  const text = await readFile(
    new URL(`../api/src/${file}`, import.meta.url),
    "utf8",
  );
  for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g))
    gateVariables.add(match[1]);
}
requireContract(
  gateVariables.has("VOICE_SPEECH_RELAY_ENABLED"),
  "Gate variable scan no longer finds the speech subscription flag",
);
for (const key of gateVariables) {
  requireContract(
    target.vars?.[key] === stage.vars?.[key],
    `Gate variable must match ${environment}: ${key}`,
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
    `Hyperdrive must reuse ${environment} resource`,
  );
}
for (const binding of target.kv_namespaces ?? []) {
  requireContract(
    stage.kv_namespaces?.some(
      (item) => item.binding === binding.binding && item.id === binding.id,
    ),
    `KV must reuse ${environment} resource`,
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
  admission.alias?.[
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
  `Admission ${environment} ${phase === "adopted" ? "steady-state" : `${phase} phase`} source contract passed; live namespace and secret parity require separate receipts.`,
);
