/**
 * Bundles the real admission gate and policy controller for Miniflare. Every
 * primary boundary is replaced by a fake that counts its use in the isolate's
 * `__ratePolicyPrimary` state and throws while `forbidden` is set, so a test
 * can prove a decision ran without Postgres.
 */
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const PRIMARY = `const primary = () => {
  globalThis.__ratePolicyPrimary ??= { dbCalls: 0, forbidden: false, policies: {}, mutations: {}, holdRate: false };
  return globalThis.__ratePolicyPrimary;
};
const touch = (what) => {
  const state = primary();
  state.dbCalls += 1;
  if (state.forbidden) throw new Error("Unexpected primary I/O: " + what);
  return state;
};`;

const BOUNDARIES: Array<[RegExp, string]> = [
  [
    /[\\/]shared[\\/]src[\\/]db[\\/]client\.ts$/,
    `${PRIMARY}
    export async function runWithDbCacheAsync(operation) { touch("db"); return operation(); }`,
  ],
  [
    /[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]inference-funded-budget-admission\.ts$/,
    `${PRIMARY}
    export async function loadInferenceBudgetPolicy(organizationId) {
      const policy = touch("policy").policies[organizationId];
      if (!policy) throw new Error("No primary policy for " + organizationId);
      return policy;
    }`,
  ],
  [
    /[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]inference-policy-fence\.ts$/,
    `${PRIMARY}
    export async function inspectInferencePolicyMutation(organizationId, mutationId) {
      return touch("mutation").mutations[organizationId + ":" + mutationId] ?? { state: "absent" };
    }`,
  ],
  [
    /[\\/]shared[\\/]src[\\/]db[\\/]repositories[\\/]inference-funding-budgets\.ts$/,
    `${PRIMARY}
    export const reserveBudget = () => touch("reserve");
    export const closeBudget = () => touch("close");
    export const recordConsumption = () => touch("consume");`,
  ],
  [
    /[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]inference-admission-recovery\.ts$/,
    `${PRIMARY}
    export async function recoverExpiredInferenceAdmissionLease() { touch("recovery"); }`,
  ],
  [
    /[\\/]shared[\\/]src[\\/]lib[\\/]runtime[\\/]cloud-bindings\.ts$/,
    `export function getCloudAwareEnv() { return {}; }
    export function getCloudBinding() { return undefined; }
    export function runWithCloudBindings(_bindings, run) { return run(); }
    export async function runWithCloudBindingsAsync(_bindings, run) { return run(); }`,
  ],
  [
    /[\\/]shared[\\/]src[\\/]lib[\\/]utils[\\/]logger\.ts$/,
    `export const logger = { debug() {}, info() {}, warn() {}, error() {} };`,
  ],
];

let bundled: Promise<string> | undefined;

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL("./inference-rate-policy-worker.ts", import.meta.url),
      ),
    ],
    format: "esm",
    target: "browser",
    conditions: ["worker", "browser"],
    plugins: [
      {
        name: "rate-policy-primary-boundaries",
        setup(build) {
          for (const [filter, contents] of BOUNDARIES)
            build.onLoad({ filter }, () => ({ loader: "js", contents }));
        },
      },
    ],
  });
  if (!built.success || !built.outputs[0])
    throw new AggregateError(built.logs, "Rate policy Worker did not bundle");
  return built.outputs[0].text();
}

export async function createRatePolicyWorker(
  flags: { ratePolicy?: boolean; strongRevocation?: boolean } = {},
): Promise<Miniflare> {
  bundled ??= bundle();
  return new Miniflare({
    modules: true,
    script: await bundled,
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      INFERENCE_ADMISSION_GATES: {
        className: "RatePolicyTestGate",
        useSQLite: true,
      },
    },
    bindings: {
      INFERENCE_RATE_POLICY_ADMISSION: String(flags.ratePolicy ?? true),
      INFERENCE_STRONG_REVOCATION_ENABLED: String(
        flags.strongRevocation ?? true,
      ),
      INFERENCE_FUNDED_BUDGET_ADMISSION: "false",
    },
  });
}

export async function gatePost(
  worker: Miniflare,
  gateName: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.dispatchFetch(
    `https://rate-policy.test${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-gate-name": gateName,
      },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

export function ratePolicy(
  organizationId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    organizationId,
    enabled: false,
    rateEnabled: true,
    epoch: "1",
    policyGeneration: "1",
    validUntil: Number.MAX_SAFE_INTEGER,
    rateLimits: {
      completionsRpm: 100,
      embeddingsRpm: 100,
      standardRpm: 100,
      strictRpm: 100,
    },
    ...overrides,
  };
}

/** The proof the Worker sends; the key cap travels with the epoch it was read under. */
export function rateProof(
  organizationId: string,
  options: {
    epoch?: string;
    generation?: string;
    keyId?: string;
    keyCap?: number;
    endpointType?: string;
    credential?: Record<string, unknown>;
  } = {},
) {
  const now = Date.now();
  return {
    organizationId,
    policyEpoch: options.epoch ?? "1",
    policyGeneration: options.generation ?? "1",
    endpointType: options.endpointType ?? "completions",
    credential: {
      kind: "api_key",
      credentialId: options.keyId ?? "key",
      userId: "user",
      rateLimit: options.keyCap ?? 1_000,
      expiresAt: null,
      ...options.credential,
    },
    operationId: crypto.randomUUID(),
    operationDeadlineAt: now + 5_000,
    windowStartedAt: Math.floor(now / 60_000) * 60_000,
  };
}
