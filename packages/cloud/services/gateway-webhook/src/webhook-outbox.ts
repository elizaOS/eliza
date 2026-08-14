/**
 * Durable delivery ownership for acknowledged platform webhooks. Redis holds
 * the one pending queue and atomically moves each message from retryable work
 * to a no-replay barrier before any non-idempotent external side effect.
 */
import type { ChatEvent, Platform } from "./adapters/types";
import type { GatewayRedis } from "./redis";

const DUE_QUEUE_KEY = "webhook:delivery:due";
const DELIVERY_TTL_SECONDS = 30 * 24 * 60 * 60;
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
const LEASE_TTL_SECONDS = 5 * 60;
export const WEBHOOK_SIDE_EFFECT_STARTED = "side_effect_started";
const WEBHOOK_DELIVERED = "delivered";

const ENQUEUE_SCRIPT = `
local claimed = redis.call("SET", KEYS[1], "queued", "NX", "EX", ARGV[2])
if not claimed then return 0 end
redis.call("SET", KEYS[2], ARGV[1], "EX", ARGV[3])
redis.call("ZADD", KEYS[3], ARGV[4], KEYS[2])
return 1
`;

const CLAIM_ONE_SCRIPT = `
local claimed = redis.call("SET", KEYS[1], ARGV[1], "NX", "EX", ARGV[2])
if not claimed then return nil end
local payload = redis.call("GET", KEYS[2])
if not payload then
  redis.call("DEL", KEYS[1])
  redis.call("ZREM", KEYS[3], KEYS[2])
  return nil
end
return payload
`;

const CLAIM_DUE_SCRIPT = `
local due = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ARGV[2])
local claimed = {}
for _, jobKey in ipairs(due) do
  local leaseKey = jobKey .. ":lease"
  local lease = redis.call("SET", leaseKey, ARGV[3], "NX", "EX", ARGV[4])
  if lease then
    local payload = redis.call("GET", jobKey)
    if payload then
      table.insert(claimed, payload)
    else
      redis.call("DEL", leaseKey)
      redis.call("ZREM", KEYS[1], jobKey)
    end
  end
end
return claimed
`;

const START_SIDE_EFFECT_SCRIPT = `
if redis.call("GET", KEYS[2]) ~= ARGV[1] then return 0 end
if not redis.call("GET", KEYS[1]) then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
redis.call("ZREM", KEYS[3], KEYS[1])
redis.call("SET", KEYS[4], "${WEBHOOK_SIDE_EFFECT_STARTED}", "EX", ARGV[4])
return 1
`;

const RESCHEDULE_SCRIPT = `
if redis.call("GET", KEYS[2]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
redis.call("ZADD", KEYS[3], ARGV[4], KEYS[1])
redis.call("DEL", KEYS[2])
return 1
`;

const COMPLETE_SCRIPT = `
if redis.call("GET", KEYS[2]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[4], "${WEBHOOK_DELIVERED}", "EX", ARGV[2])
redis.call("ZREM", KEYS[3], KEYS[1])
redis.call("DEL", KEYS[1])
redis.call("DEL", KEYS[2])
return 1
`;

export interface WebhookDeliveryJob {
  version: 1;
  jobKey: string;
  dedupKey: string;
  platform: Platform;
  project: string;
  agentId?: string;
  event: ChatEvent;
  createdAt: number;
  attempts: number;
  state: "queued" | typeof WEBHOOK_SIDE_EFFECT_STARTED;
  sideEffect?: "runtime_dispatch" | "provider_egress";
  lastError?: string;
}

export interface ClaimedWebhookDelivery {
  job: WebhookDeliveryJob;
  owner: string;
}

function parseJob(payload: unknown): WebhookDeliveryJob {
  const value =
    typeof payload === "string" ? (JSON.parse(payload) as unknown) : payload;
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("jobKey" in value) ||
    typeof value.jobKey !== "string" ||
    !("dedupKey" in value) ||
    typeof value.dedupKey !== "string" ||
    !("platform" in value) ||
    !["telegram", "blooio", "twilio", "whatsapp"].includes(
      String(value.platform),
    ) ||
    !("project" in value) ||
    typeof value.project !== "string" ||
    !("event" in value) ||
    !value.event ||
    typeof value.event !== "object" ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "number" ||
    !("attempts" in value) ||
    typeof value.attempts !== "number" ||
    !("state" in value) ||
    (value.state !== "queued" && value.state !== WEBHOOK_SIDE_EFFECT_STARTED)
  ) {
    throw new TypeError("Redis returned an invalid webhook delivery job");
  }
  return value as WebhookDeliveryJob;
}

export async function enqueueWebhookDelivery(
  redis: GatewayRedis,
  input: Omit<
    WebhookDeliveryJob,
    "version" | "jobKey" | "createdAt" | "attempts" | "state"
  >,
): Promise<WebhookDeliveryJob | null> {
  const job: WebhookDeliveryJob = {
    ...input,
    version: 1,
    jobKey: `${input.dedupKey}:delivery`,
    createdAt: Date.now(),
    attempts: 0,
    state: "queued",
  };
  const enqueued = await redis.eval<number>(
    ENQUEUE_SCRIPT,
    [job.dedupKey, job.jobKey, DUE_QUEUE_KEY],
    [
      JSON.stringify(job),
      String(DELIVERY_TTL_SECONDS),
      String(JOB_TTL_SECONDS),
      String(job.createdAt),
    ],
  );
  return Number(enqueued) === 1 ? job : null;
}

export async function claimWebhookDelivery(
  redis: GatewayRedis,
  jobKey: string,
  owner: string,
): Promise<ClaimedWebhookDelivery | null> {
  const payload = await redis.eval<unknown>(
    CLAIM_ONE_SCRIPT,
    [`${jobKey}:lease`, jobKey, DUE_QUEUE_KEY],
    [owner, String(LEASE_TTL_SECONDS)],
  );
  return payload === null ? null : { job: parseJob(payload), owner };
}

export async function claimDueWebhookDeliveries(
  redis: GatewayRedis,
  owner: string,
  limit: number,
): Promise<ClaimedWebhookDelivery[]> {
  const payloads = await redis.eval<unknown[]>(
    CLAIM_DUE_SCRIPT,
    [DUE_QUEUE_KEY],
    [String(Date.now()), String(limit), owner, String(LEASE_TTL_SECONDS)],
  );
  return payloads.map((payload) => ({ job: parseJob(payload), owner }));
}

export async function markWebhookSideEffectStarted(
  redis: GatewayRedis,
  delivery: ClaimedWebhookDelivery,
  sideEffect: "runtime_dispatch" | "provider_egress",
): Promise<void> {
  const job: WebhookDeliveryJob = {
    ...delivery.job,
    state: WEBHOOK_SIDE_EFFECT_STARTED,
    sideEffect,
  };
  const changed = await redis.eval<number>(
    START_SIDE_EFFECT_SCRIPT,
    [job.jobKey, `${job.jobKey}:lease`, DUE_QUEUE_KEY, job.dedupKey],
    [
      delivery.owner,
      JSON.stringify(job),
      String(JOB_TTL_SECONDS),
      String(DELIVERY_TTL_SECONDS),
    ],
  );
  if (Number(changed) !== 1) {
    throw new Error("Webhook delivery lease expired before external egress");
  }
  delivery.job = job;
}

export async function rescheduleWebhookDelivery(
  redis: GatewayRedis,
  delivery: ClaimedWebhookDelivery,
  error: unknown,
): Promise<void> {
  const attempts = delivery.job.attempts + 1;
  const job: WebhookDeliveryJob = {
    ...delivery.job,
    attempts,
    state: "queued",
    lastError: (error instanceof Error ? error.message : String(error)).slice(
      0,
      500,
    ),
  };
  delete job.sideEffect;
  const dueAt =
    Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6));
  const changed = await redis.eval<number>(
    RESCHEDULE_SCRIPT,
    [job.jobKey, `${job.jobKey}:lease`, DUE_QUEUE_KEY],
    [
      delivery.owner,
      JSON.stringify(job),
      String(JOB_TTL_SECONDS),
      String(dueAt),
    ],
  );
  if (Number(changed) !== 1) {
    throw new Error("Webhook delivery lease expired before retry scheduling");
  }
  delivery.job = job;
}

export async function completeWebhookDelivery(
  redis: GatewayRedis,
  delivery: ClaimedWebhookDelivery,
): Promise<void> {
  const changed = await redis.eval<number>(
    COMPLETE_SCRIPT,
    [
      delivery.job.jobKey,
      `${delivery.job.jobKey}:lease`,
      DUE_QUEUE_KEY,
      delivery.job.dedupKey,
    ],
    [delivery.owner, String(DELIVERY_TTL_SECONDS)],
  );
  if (Number(changed) !== 1) {
    throw new Error("Webhook delivery lease expired before completion");
  }
}
