import Redis from "ioredis";
import { Log } from "pepr";

const REDIS_URL = process.env.REDIS_URL || "redis://redis.eliza-infra.svc:6379";
const AGENT_ROUTING_TTL_SECONDS = 30 * 24 * 3600;
let client: Redis | null = null;

function getClient(): Redis {
  if (!client) {
    client = new Redis(REDIS_URL, {
      retryStrategy: (times) => Math.min(times * 500, 5000),
      maxRetriesPerRequest: 3,
    });
    client.on("error", (err) => Log.error(err, "Redis connection error"));
  }
  return client;
}

export async function setServerState(name: string, phase: string, url: string) {
  const redis = getClient();
  await redis
    .multi()
    .set(`server:${name}:status`, phase, "EX", AGENT_ROUTING_TTL_SECONDS)
    .set(`server:${name}:url`, url, "EX", AGENT_ROUTING_TTL_SECONDS)
    .exec();
}

export async function setAgentServer(agentId: string, serverName: string) {
  const redis = getClient();
  await redis.set(`agent:${agentId}:server`, serverName, "EX", AGENT_ROUTING_TTL_SECONDS);
}

export async function removeAgentServer(agentId: string) {
  const redis = getClient();
  await redis.del(`agent:${agentId}:server`);
}

export async function cleanupServer(name: string, agentIds: string[]) {
  const redis = getClient();
  const keys = [
    `server:${name}:status`,
    `server:${name}:url`,
    `keda:${name}:activity`,
    ...agentIds.map((id) => `agent:${id}:server`),
  ];
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
