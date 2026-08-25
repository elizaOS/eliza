/** Proves each gateway Redis transport uses its purpose-bound read-only path. */
import { describe, expect, spyOn, test } from "bun:test";
import {
  ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT,
  ACTIVATION_ROUTING_UPSTASH_READ_ONLY_SCRIPT,
  type ActivationRoutingSnapshotKeys,
} from "@elizaos/cloud-services-common";
import { Redis as UpstashRedis } from "@upstash/redis";
import IORedis from "ioredis";
import { createRedis, NativeRedisAdapter, UpstashRedisAdapter } from "../redis";

const SNAPSHOT_KEYS: ActivationRoutingSnapshotKeys = [
  "agent:00000000-0000-4000-8000-000000000001:routing-managed",
  "agent:00000000-0000-4000-8000-000000000001:registration-authority",
  "agent:00000000-0000-4000-8000-000000000001:activation-route",
];
const SNAPSHOT = [
  "activation-routing-snapshot:v1",
  "activation-routing-missing:v1",
  "activation-routing-missing:v1",
  "activation-routing-missing:v1",
];

type FetchImplementation = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

function hermeticFetch(implementation: FetchImplementation): typeof fetch {
  return Object.assign(implementation, { preconnect: () => undefined });
}

function restoreEnvironmentValue(
  name: "MOCK_REDIS" | "REDIS_URL" | "KV_REST_API_URL" | "KV_REST_API_TOKEN",
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("activation-routing Redis transports", () => {
  test("native Redis uses EVAL_RO exactly and never falls back to EVAL", async () => {
    const client = new IORedis({ lazyConnect: true });
    const evalRo = spyOn(client, "eval_ro").mockResolvedValue(SNAPSHOT);
    const evalWrite = spyOn(client, "eval").mockResolvedValue(SNAPSHOT);
    const redis = new NativeRedisAdapter(client);

    try {
      expect(await redis.readActivationRoutingSnapshot(SNAPSHOT_KEYS)).toEqual(
        SNAPSHOT,
      );
      expect(evalRo).toHaveBeenCalledTimes(1);
      expect(evalRo).toHaveBeenCalledWith(
        ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT,
        3,
        ...SNAPSHOT_KEYS,
      );
      expect(evalWrite).not.toHaveBeenCalled();
    } finally {
      evalRo.mockRestore();
      evalWrite.mockRestore();
      client.disconnect();
    }
  });

  test("Upstash uses evalRo exactly and never calls mutating eval", async () => {
    const requestBodies: unknown[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      hermeticFetch(async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)) as unknown);
        return new Response(
          JSON.stringify([
            {
              result: SNAPSHOT.map((value) =>
                Buffer.from(value).toString("base64"),
              ),
            },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    try {
      const client = new UpstashRedis({
        url: "https://example.invalid",
        token: "test-token",
        automaticDeserialization: false,
      });
      const redis = new UpstashRedisAdapter(client);

      expect(await redis.readActivationRoutingSnapshot(SNAPSHOT_KEYS)).toEqual(
        SNAPSHOT,
      );
      expect(requestBodies).toEqual([
        [
          [
            "eval_ro",
            ACTIVATION_ROUTING_UPSTASH_READ_ONLY_SCRIPT,
            3,
            ...SNAPSHOT_KEYS,
          ],
        ],
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("Upstash preserves raw missing and literal-null routing values", async () => {
    const previousEnvironment = {
      MOCK_REDIS: process.env.MOCK_REDIS,
      REDIS_URL: process.env.REDIS_URL,
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    };
    const encodedResults: Array<string | null> = [null, "bnVsbA==", "bnVsbA=="];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      hermeticFetch(async () => {
        const result = encodedResults.shift();
        if (result === undefined) {
          throw new Error("unexpected extra Upstash request");
        }
        return new Response(JSON.stringify([{ result }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    delete process.env.MOCK_REDIS;
    delete process.env.REDIS_URL;
    process.env.KV_REST_API_URL = "https://example.invalid";
    process.env.KV_REST_API_TOKEN = "test-token";

    try {
      const redis = createRedis();
      expect(await redis.readAgentServerRoutingValue("missing")).toBeNull();
      expect(await redis.readAgentServerRoutingValue("literal-null")).toBe(
        "null",
      );
      expect(await redis.get("literal-null")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(encodedResults).toHaveLength(0);
    } finally {
      fetchMock.mockRestore();
      restoreEnvironmentValue("MOCK_REDIS", previousEnvironment.MOCK_REDIS);
      restoreEnvironmentValue("REDIS_URL", previousEnvironment.REDIS_URL);
      restoreEnvironmentValue(
        "KV_REST_API_URL",
        previousEnvironment.KV_REST_API_URL,
      );
      restoreEnvironmentValue(
        "KV_REST_API_TOKEN",
        previousEnvironment.KV_REST_API_TOKEN,
      );
    }
  });
});
