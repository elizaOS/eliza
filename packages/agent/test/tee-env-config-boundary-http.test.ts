/** Drives the production config HTTP route with an owner token: TEE, dstack, confidential and protected-profile environment keys can neither be persisted nor set or cleared in the live process, while ordinary variables still apply. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRuntime } from "@elizaos/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

const token = randomUUID();
let stateDirectory: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeAll(async () => {
  stateDirectory = await mkdtemp(path.join(tmpdir(), "eliza-tee-env-http-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: stateDirectory,
    ELIZA_CONFIG_PATH: path.join(stateDirectory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(stateDirectory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
    ELIZA_TEE_REQUIRED: "true",
  }))
    vi.stubEnv(key, value);
  for (const key of [
    "ELIZA_CLOUD_PROVISIONED",
    "ELIZA_PROTECTED_PROFILE",
    "ELIZA_DSTACK_EVIDENCE_CONFIG_JSON",
    "ELIZA_CONFIDENTIAL_WEIGHTS",
    "BOUNDARY_ACCEPTED_VAR",
  ])
    vi.stubEnv(key, undefined);
  fixture = await createTestRuntime({ characterName: "TeeEnvBoundary" });
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

it("never persists or applies TEE authority keys from config writes", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      env: {
        ELIZA_TEE_POLICY_JSON: '{"required":false}',
        vars: {
          ELIZA_TEE_REQUIRED: "",
          ELIZA_PROTECTED_PROFILE: "dstack-cpu",
          ELIZA_DSTACK_EVIDENCE_CONFIG_JSON: "{}",
          ELIZA_CONFIDENTIAL_WEIGHTS: "1",
          BOUNDARY_ACCEPTED_VAR: "kept",
        },
      },
    }),
  });
  expect(response.status).toBe(200);

  expect(process.env.ELIZA_TEE_REQUIRED).toBe("true");
  expect(process.env.ELIZA_TEE_POLICY_JSON).toBeUndefined();
  expect(process.env.ELIZA_PROTECTED_PROFILE).toBeUndefined();
  expect(process.env.ELIZA_DSTACK_EVIDENCE_CONFIG_JSON).toBeUndefined();
  expect(process.env.ELIZA_CONFIDENTIAL_WEIGHTS).toBeUndefined();
  expect(process.env.BOUNDARY_ACCEPTED_VAR).toBe("kept");

  const persisted = JSON.parse(
    await readFile(path.join(stateDirectory, "eliza.json"), "utf8"),
  );
  expect(persisted.env.vars).toEqual({ BOUNDARY_ACCEPTED_VAR: "kept" });
  expect(persisted.env.ELIZA_TEE_POLICY_JSON).toBeUndefined();
}, 120_000);
