import { describe, expect, test } from "bun:test";
import type { CacheRedisClient } from "./adapters/types";
import { CacheClient } from "./client";

function clientWith(redis: CacheRedisClient): CacheClient {
  const client = new CacheClient();
  Object.assign(client as unknown as Record<string, unknown>, {
    initialized: true,
    enabled: true,
    redis,
  });
  return client;
}

describe("CacheClient.scanByPrefix", () => {
  test("rejects when a later scan page fails instead of returning a partial list", async () => {
    let scans = 0;
    const redis = {
      backend: "redis-socket",
      scan: async () => {
        scans += 1;
        if (scans === 1) {
          return ["opaque-page-token", ["local:pending:a", "local:pending:b"]] as [
            string,
            string[],
          ];
        }
        throw new Error("upstream scan failed");
      },
    } as unknown as CacheRedisClient;
    const client = clientWith(redis);
    await expect(client.scanByPrefix("pending:", 1000)).rejects.toThrow("upstream scan failed");
  });
});
