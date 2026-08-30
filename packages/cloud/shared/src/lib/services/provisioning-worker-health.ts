// Coordinates cloud service provisioning worker health behavior behind route handlers.
import {
  buildRedisClient,
  type CompatibleRedis,
  type RedisFactoryEnv,
} from "../cache/redis-factory";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { withTimeout } from "../utils/with-timeout";

/**
 * Cap on the heartbeat Redis SET. Redis has been flaky in prod; without this
 * the publish can hang indefinitely and (in the daemon's interval) pile up
 * unresolved promises. 5s is generous for a single SET against Upstash/Redis.
 */
const HEARTBEAT_SET_TIMEOUT_MS = 5_000;

/**
 * Redis key the provisioning-worker daemon SETs with a short TTL every
 * cycle. When the key is missing the daemon is considered unhealthy
 * (either down or paused).
 *
 * The daemon writes; the cloud-api Worker reads. Both processes already
 * share an Upstash/Redis instance via `buildRedisClient`, so this is
 * cheaper than a DB round-trip and gives self-healing via TTL.
 */
export const PROVISIONING_WORKER_HEARTBEAT_KEY = "provisioning_worker:health";
export const REVIEWED_BACKUP_RESTORE_CAPABILITY = "reviewed-backup-restore-v1";
const PROVISIONING_WORKER_CAPABILITIES = [REVIEWED_BACKUP_RESTORE_CAPABILITY] as const;

/**
 * How long a single heartbeat is valid. The daemon refreshes every ~15s
 * (cycle interval), so 60s leaves room for 4 missed cycles before the
 * gate trips. Keep in sync with `PROVISIONING_WORKER_HEARTBEAT_TTL_S` on
 * the daemon side.
 */
export const PROVISIONING_WORKER_HEARTBEAT_TTL_S = 60;

export type ProvisioningWorkerHealth =
  | {
      ok: true;
      required: boolean;
      lastHeartbeatAt?: string;
      capabilities?: readonly string[];
    }
  | {
      ok: false;
      required: true;
      status: 502 | 503;
      code:
        | "PROVISIONING_WORKER_NOT_CONFIGURED"
        | "PROVISIONING_WORKER_UNHEALTHY"
        | "PROVISIONING_WORKER_UNREACHABLE"
        | "PROVISIONING_WORKER_CAPABILITY_REQUIRED";
      error: string;
    };

function isProvisioningWorkerRequired(): boolean {
  const env = getCloudAwareEnv();
  return env.NODE_ENV === "production" || env.REQUIRE_PROVISIONING_WORKER === "true";
}

function getRedis(): CompatibleRedis | null {
  const env = getCloudAwareEnv() as RedisFactoryEnv;
  return buildRedisClient(env);
}

export async function checkProvisioningWorkerHealth(
  redisOverride?: CompatibleRedis | null,
): Promise<ProvisioningWorkerHealth> {
  const required = isProvisioningWorkerRequired();
  const redis = redisOverride === undefined ? getRedis() : redisOverride;

  if (!required) {
    return { ok: true, required: false };
  }

  if (!redis) {
    // The daemon publishes its liveness to Redis; THIS reader (the cloud-api
    // Worker) having no Redis binding is a config gap in the READER, not
    // evidence the daemon is down. Hard-503'ing here blocks ALL provisioning
    // whenever the Worker's Redis binding is missing (e.g. mid Redis-cutover) —
    // even though the daemon is alive and claiming jobs. Fall open instead, the
    // same way the rate-limiter does when Redis is unconfigured. When the
    // Worker's Redis IS configured, a stale/missing heartbeat still fails closed
    // below — so this only relaxes the unconfigured-reader case.
    return { ok: true, required: false };
  }

  let raw: unknown;
  try {
    raw = await redis.get(PROVISIONING_WORKER_HEARTBEAT_KEY);
  } catch (error) {
    return {
      ok: false,
      required: true,
      status: 502,
      code: "PROVISIONING_WORKER_UNREACHABLE",
      error:
        error instanceof Error
          ? `Failed to read provisioning worker heartbeat from Redis: ${error.message}`
          : "Failed to read provisioning worker heartbeat from Redis.",
    };
  }

  if (!raw) {
    return {
      ok: false,
      required: true,
      status: 503,
      code: "PROVISIONING_WORKER_UNHEALTHY",
      error: "Provisioning worker has not reported a heartbeat in the last 60 seconds.",
    };
  }

  let lastHeartbeatAt = typeof raw === "string" ? raw : undefined;
  let capabilities: readonly string[] = [];
  let parsed: unknown = raw;
  try {
    if (typeof raw === "string") parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 Legacy workers publish a bare ISO timestamp, which is
    // valid liveness but intentionally carries no execution capabilities.
    parsed = null;
  }
  if (parsed !== null && typeof parsed === "object") {
    const heartbeat = parsed as { timestamp?: unknown; capabilities?: unknown };
    if (typeof heartbeat.timestamp === "string") lastHeartbeatAt = heartbeat.timestamp;
    if (
      Array.isArray(heartbeat.capabilities) &&
      heartbeat.capabilities.every((capability) => typeof capability === "string")
    ) {
      capabilities = heartbeat.capabilities;
    }
  }

  return { ok: true, required: true, lastHeartbeatAt, capabilities };
}

/** Fail closed when the API is about to enqueue a job older workers misinterpret. */
export async function checkProvisioningWorkerCapability(
  capability: string,
  redisOverride?: CompatibleRedis | null,
): Promise<ProvisioningWorkerHealth> {
  if (!isProvisioningWorkerRequired()) return { ok: true, required: false };
  const redis = redisOverride === undefined ? getRedis() : redisOverride;
  if (!redis) {
    return {
      ok: false,
      required: true,
      status: 503,
      code: "PROVISIONING_WORKER_NOT_CONFIGURED",
      error: "Provisioning worker capability cannot be verified.",
    };
  }
  const health = await checkProvisioningWorkerHealth(redis);
  if (!health.ok) return health;
  if (!health.capabilities?.includes(capability)) {
    return {
      ok: false,
      required: true,
      status: 503,
      code: "PROVISIONING_WORKER_CAPABILITY_REQUIRED",
      error: "Provisioning worker must be updated before this Dedicated activation can start.",
    };
  }
  return health;
}

export function provisioningWorkerFailureBody(
  health: Extract<ProvisioningWorkerHealth, { ok: false }>,
) {
  return {
    success: false,
    code: health.code,
    error: health.error,
    retryable: true,
  };
}

/**
 * Called by the provisioning-worker daemon (Bun on the orchestrator VM)
 * at the start of every poll cycle. Stores `now` in Redis with a 60s
 * TTL so `checkProvisioningWorkerHealth()` reads a fresh value.
 *
 * Returns true if the heartbeat was written; false if Redis is not
 * configured. Surface failures via the returned promise — the daemon
 * decides whether to log loudly or swallow.
 */
export async function publishProvisioningWorkerHeartbeat(
  redisOverride?: CompatibleRedis | null,
): Promise<boolean> {
  const redis = redisOverride === undefined ? getRedis() : redisOverride;
  if (!redis) return false;
  const heartbeat = JSON.stringify({
    timestamp: new Date().toISOString(),
    capabilities: PROVISIONING_WORKER_CAPABILITIES,
  });
  await withTimeout(
    Promise.resolve(
      redis.set(PROVISIONING_WORKER_HEARTBEAT_KEY, heartbeat, {
        ex: PROVISIONING_WORKER_HEARTBEAT_TTL_S,
      }),
    ),
    HEARTBEAT_SET_TIMEOUT_MS,
    "heartbeat redis set",
  );
  return true;
}
