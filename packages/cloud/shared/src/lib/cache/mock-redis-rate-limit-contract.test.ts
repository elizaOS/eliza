import { expect, test } from "bun:test";
import { checkUpstash } from "../middleware/rate-limit-hono-cloudflare";
import { MockSocketRedis } from "./mock-redis";

test("MockSocketRedis implements the batched rate-limit pipeline contract", async () => {
  const client = new MockSocketRedis();
  const key = "mock-pipeline-contract";
  await client.del(`ratelimit:${key}`);

  const first = await checkUpstash(client, key, 60_000, 5);
  const second = await checkUpstash(client, key, 60_000, 5);

  expect(first.allowed).toBe(true);
  expect(first.remaining).toBe(4);
  expect(second.allowed).toBe(true);
  expect(second.remaining).toBe(3);
  expect(second.resetAt).toBeGreaterThan(Date.now());
});
