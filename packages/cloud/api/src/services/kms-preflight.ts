/**
 * Cold-start KMS backend preflight for the cloud-api Worker.
 *
 * WHY (the gap this fills):
 *   `getKmsClient()` (packages/cloud/shared/src/db/crypto/kms-client.ts) already
 *   refuses the ephemeral `memory` backend in a deployed environment — but it
 *   does so LAZILY, on the first crypto call. In practice that means the first
 *   SIWE signup / API-key encryption / BYO-secret write after a misconfigured
 *   deploy is the thing that discovers the problem, as a runtime 500. QA (and
 *   worse, real users) become the alarm.
 *
 *   The provisioning-worker daemon has an eager preflight
 *   (`assertKmsBackendDurable`) that runs before it claims a job. The Worker had
 *   no equivalent: nothing evaluates the backend at cold start. This module is
 *   that equivalent — evaluated once in `createApp()`.
 *
 * DESIGN CONSTRAINTS (deliberate):
 *   - NON-THROWING. The Worker must not be taken down by this check. A cold
 *     start that `throw`s from `createApp()` yields Cloudflare error 1101 for
 *     EVERY route — including `/api/health`, the beacon a deploy verifier reads.
 *     Taking the whole surface down (health included) is strictly worse than
 *     serving with a loud error logged: the crypto paths already fail closed via
 *     `getKmsClient()`'s throw, while health/login/read paths keep working so
 *     the deploy is observable and diagnosable. So: `logger.error`, never throw.
 *   - LOUD + STRUCTURED. One `logger.error` line with a stable prefix
 *     (`[kms-preflight]`) and a `code` so log-based alerts can grep it.
 *   - NEVER logs key material. Only the backend *class* and the env markers that
 *     drove the decision.
 *
 * Keep the `memory`-is-ephemeral policy in sync with `isEphemeralKmsAllowed`
 * (kms-client.ts) and `assertKmsBackendDurable` (provisioning-worker.ts).
 */

import { isEphemeralKmsAllowed } from "@elizaos/cloud-shared/db/crypto/kms-client";
import { createKmsClient, resolveKmsBackend } from "@elizaos/security/kms";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { logger } from "@/lib/utils/logger";

export type KmsBackendClass = "memory" | "local" | "steward";

export interface KmsPreflightResult {
  /** The backend the factory will resolve to for this isolate. */
  backend: KmsBackendClass;
  /**
   * `true` when the resolved backend is BOTH policy-durable for this
   * environment (not the ephemeral `memory` backend where it is forbidden) AND
   * actually usable (its key material / config resolves). `false` when it is
   * the forbidden `memory` backend OR a `local`/`steward` backend whose key or
   * config is missing/malformed — both of which fail the crypto path at
   * runtime. This mirrors the checks `getKmsClient()` enforces lazily, so the
   * preflight/health signal cannot report a broken configuration as healthy.
   */
  durable: boolean;
  /**
   * Non-null diagnostic reason when `durable` is `false` (never key material —
   * only a coarse cause + the underlying error message, which the security
   * factory writes without embedding the key). `null` when durable.
   */
  reason: string | null;
  /** `ENVIRONMENT` marker that drove the durability decision (never a secret). */
  environment: string | null;
  /** `NODE_ENV` marker that drove the durability decision (never a secret). */
  nodeEnv: string | null;
}

/**
 * Resolve the KMS backend + whether it is durable AND usable for this
 * environment.
 *
 * Two-part check, matching what the crypto path enforces lazily:
 *   1. POLICY: the ephemeral `memory` backend is forbidden outside
 *      test/development/local ({@link isEphemeralKmsAllowed}).
 *   2. USABILITY: the resolved backend must actually construct — a `local`
 *      backend with a missing/malformed `ELIZA_LOCAL_ROOT_KEY`, or a `steward`
 *      backend without config, would report a healthy backend NAME while the
 *      first real crypto call throws from `createKmsClient()`/`getKmsClient()`.
 *      We run `createKmsClient({ env })` in a try/catch to exercise the exact
 *      resolution the crypto path uses. This is cheap: the factory constructs
 *      an adapter object with NO I/O and NO network; it does not touch the DB
 *      or perform any crypto. On throw we treat the backend as non-durable and
 *      capture the (key-free) error message as the reason.
 */
export function evaluateKmsPreflight(
  env: NodeJS.ProcessEnv = getCloudAwareEnv(),
): KmsPreflightResult {
  const backend = resolveKmsBackend({ env }) as KmsBackendClass;
  const base = {
    backend,
    environment: env.ENVIRONMENT ?? null,
    nodeEnv: env.NODE_ENV ?? null,
  };

  // Policy gate first: the ephemeral memory backend is forbidden outside
  // test/development/local, regardless of whether it would "construct".
  if (backend === "memory" && !isEphemeralKmsAllowed(env)) {
    return {
      ...base,
      durable: false,
      reason:
        "ephemeral 'memory' backend is forbidden in this environment (rotates its key on every isolate restart)",
    };
  }

  // Usability gate: exercise the real factory resolution. A local backend with
  // a missing/malformed root key (or a steward backend without config) throws
  // here exactly as it would at the first crypto call.
  try {
    createKmsClient({ env });
  } catch (error) {
    return {
      ...base,
      durable: false,
      reason: `KMS backend '${backend}' does not resolve to a usable client: ${(error as Error).message}`,
    };
  }

  return { ...base, durable: true, reason: null };
}

/**
 * Cold-start preflight. Evaluates the KMS backend once and emits a LOUD
 * structured `logger.error` whenever it resolved to a NON-DURABLE backend —
 * the ephemeral `memory` backend where the shared policy
 * ({@link isEphemeralKmsAllowed}) forbids it, OR a `local`/`steward` backend
 * whose key/config does not resolve to a usable client. Never throws — see the
 * module header.
 *
 * The durability signal is authoritative: it is `false` for exactly the
 * configurations the crypto path treats as fatal. We deliberately do NOT add a
 * narrower staging-or-production env gate on top — that would go SILENT for a
 * genuinely fatal launch that resolved `memory` with `ENVIRONMENT` unset (a
 * deploy that forgot its config), diverging from the policy `getKmsClient()`
 * enforces at the crypto path. Test/development/local resolve `durable: true`,
 * so those stay quiet without a special case here.
 *
 * Returns the evaluation so callers/tests can assert on it without re-reading
 * env or scraping logs.
 */
export function runKmsColdStartPreflight(
  env: NodeJS.ProcessEnv = getCloudAwareEnv(),
): KmsPreflightResult {
  const result = evaluateKmsPreflight(env);

  if (!result.durable) {
    logger.error(
      "[kms-preflight] FATAL: cloud-api resolved a NON-DURABLE KMS " +
        "configuration — either the ephemeral 'memory' backend where the " +
        "shared policy forbids it (rotates its key on every isolate restart, " +
        "orphaning every encrypted record), or a 'local'/'steward' backend " +
        "whose key/config does not resolve to a usable client (#15310). Crypto " +
        "writes (SIWE signup, API-key encryption, BYO secrets) will 500 " +
        "(getKmsClient throws). Cutover: set ELIZA_KMS_BACKEND=local with a " +
        "persistent, base64-encoded 32-byte ELIZA_LOCAL_ROOT_KEY (or configure " +
        "the steward backend), then redeploy.",
      {
        code: "KMS_NON_DURABLE_BACKEND",
        backend: result.backend,
        // Coarse cause + the security factory's (key-free) error message. Never
        // contains key material — the factory throws with a description, not the
        // key value.
        reason: result.reason,
        environment: result.environment,
        nodeEnv: result.nodeEnv,
      },
    );
  }

  return result;
}

/**
 * Module-scoped guard so the preflight logs at most once per isolate. Reset
 * only via {@link resetKmsPreflightOnceForTests}.
 */
let _preflightHasRun = false;

/**
 * Run {@link runKmsColdStartPreflight} at most ONCE per isolate.
 *
 * WHY a request-time once-guard instead of a `createApp()` cold-start call:
 * on Cloudflare Workers the wrangler bindings/secrets (`ELIZA_KMS_BACKEND`,
 * `ELIZA_LOCAL_ROOT_KEY`, `ENVIRONMENT`) are supplied on the per-request
 * `c.env` and are only visible to shared code inside
 * `runWithCloudBindings(c.env, ...)`. `createApp()` runs BEFORE any request, so
 * a cold-start read of `process.env` can miss a backend configured purely as a
 * Worker secret and resolve the default — emitting no error for exactly the
 * misconfig this check exists to catch (#15310). Invoked from the first
 * request's cloud-bindings middleware, {@link getCloudAwareEnv} sees the real
 * `c.env`, so the resolution is authoritative. The once-guard keeps it a
 * cold-start-style signal (one line per isolate, not per request).
 *
 * Never throws (the underlying preflight never throws); the guard is set before
 * the call so a hypothetical throw still cannot re-arm a per-request log storm.
 */
export function runKmsPreflightOnce(
  env: NodeJS.ProcessEnv = getCloudAwareEnv(),
): void {
  if (_preflightHasRun) return;
  _preflightHasRun = true;
  runKmsColdStartPreflight(env);
}

/** Reset the once-guard. Tests only. */
export function resetKmsPreflightOnceForTests(): void {
  _preflightHasRun = false;
}
