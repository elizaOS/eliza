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
    }
  | {
      ok: false;
      required: true;
      status: 502 | 503;
      code:
        | "PROVISIONING_WORKER_NOT_CONFIGURED"
        | "PROVISIONING_WORKER_UNHEALTHY"
        | "PROVISIONING_WORKER_UNREACHABLE";
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

  let raw: string | null;
  try {
    raw = (await redis.get(PROVISIONING_WORKER_HEARTBEAT_KEY)) as string | null;
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

  return { ok: true, required: true, lastHeartbeatAt: raw };
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
  const timestamp = new Date().toISOString();
  await withTimeout(
    Promise.resolve(
      redis.set(PROVISIONING_WORKER_HEARTBEAT_KEY, timestamp, {
        ex: PROVISIONING_WORKER_HEARTBEAT_TTL_S,
      }),
    ),
    HEARTBEAT_SET_TIMEOUT_MS,
    "heartbeat redis set",
  );
  return true;
}
