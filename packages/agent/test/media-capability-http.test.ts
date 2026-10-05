/**
 * Ordinary-host media serving through the production API server: stored
 * media stays a content-addressed capability served before the auth gate, so
 * `<img>`/`<audio>` loads need no credential, while every other API path on the
 * same server still requires one. The protected-profile counterpart is
 * protected-media-access.test.ts.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  isMediaAuthRequired,
  persistMediaBytes,
} from "../src/api/media-store.ts";
import { startApiServer } from "../src/api/server.ts";

const token = randomUUID();
const BYTES = Buffer.from("ordinary host media capability bytes");
let stateDirectory: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeAll(async () => {
  stateDirectory = await mkdtemp(path.join(tmpdir(), "eliza-media-http-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: stateDirectory,
    ELIZA_CONFIG_PATH: path.join(stateDirectory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(stateDirectory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  vi.stubEnv("ELIZA_PROTECTED_PROFILE", undefined);
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  fixture = await createTestRuntime({ characterName: "MediaCapability" });
  server = await startApiServer({
    port: 0,
    runtime: fixture.runtime,
    skipDeferredStartupWork: true,
  });
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
  if (stateDirectory)
    await rm(stateDirectory, { recursive: true, force: true });
}, 120_000);

it("serves stored media without credentials on an ordinary host", async () => {
  expect(isMediaAuthRequired()).toBe(false);
  const { url } = persistMediaBytes(BYTES, "text/plain");
  const media = await fetch(`http://127.0.0.1:${server.port}${url}`);
  expect(media.status).toBe(200);
  expect(Buffer.from(await media.arrayBuffer()).equals(BYTES)).toBe(true);

  const api = await fetch(`http://127.0.0.1:${server.port}/api/config`);
  expect(api.status).toBe(401);
}, 120_000);
