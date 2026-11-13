/**
 * The diagnostics log behind GET /api/logs keeps the newest
 * ELIZA_API_LOG_BUFFER_MAX entries over the real API server and logger, so a
 * long-running agent does not grow it without limit. A recent
 * insufficient-credits warning, which chat replies look back for, stays in it.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentLogEntry,
  INSUFFICIENT_CREDITS_REPLY,
  logger,
} from "@elizaos/core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { resolveNoResponseFallback } from "../src/api/chat-routes.ts";
import { startApiServer } from "../src/api/server.ts";

const MAX = 50;
const token = randomUUID();
let directory: string;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "api-log-buffer-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", join(directory, "eliza.json"));
  vi.stubEnv("ELIZA_API_TOKEN", token);
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
  vi.stubEnv("ELIZA_API_LOG_BUFFER_MAX", String(MAX));
  server = await startApiServer({
    port: 0,
    skipDeferredStartupWork: true,
    initialAgentState: "not_started",
  });
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
}, 120_000);

it("keeps the newest entries and a recent credits warning", async () => {
  const run = randomUUID();
  // test/setup.ts sets LOG_LEVEL=error, so the lines are logged at error.
  logger.error(`[retention-test] ${run} Cloud error: insufficient credits`);
  for (let index = 0; index < 400; index += 1) {
    logger.error(`[retention-test] ${run} line ${index}`);
  }

  const response = await fetch(`http://127.0.0.1:${server.port}/api/logs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const { entries } = (await response.json()) as {
    entries: AgentLogEntry[];
  };
  expect(entries.length).toBeGreaterThanOrEqual(MAX);
  expect(entries.length).toBeLessThanOrEqual(MAX + Math.ceil(MAX / 10));
  const messages = entries.map((entry) => entry.message);
  expect(messages).toContain(
    `[retention-test] ${run} Cloud error: insufficient credits`,
  );
  expect(messages).toContain(`[retention-test] ${run} line 399`);
  expect(messages).not.toContain(`[retention-test] ${run} line 0`);
  expect(resolveNoResponseFallback(entries)).toBe(INSUFFICIENT_CREDITS_REPLY);
});
