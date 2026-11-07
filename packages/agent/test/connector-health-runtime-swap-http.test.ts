/** /api/health reports the connectors of the runtime that is running now, after an in-process runtime swap. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type IAgentRuntime, Service } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

class SlackConnectorService extends Service {
  static override serviceType = "slack";
  override capabilityDescription = "Slack connector";
  static override async start(runtime: IAgentRuntime) {
    return new SlackConnectorService(runtime);
  }
  override async stop() {}
}

const apiToken = randomUUID();
let directory: string;
let first: Awaited<ReturnType<typeof createTestRuntime>>;
let second: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-connector-health-"));
  const configPath = path.join(directory, "eliza.json");
  await writeFile(
    configPath,
    JSON.stringify({ connectors: { slack: { enabled: true } } }),
  );
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: configPath,
    ELIZA_PERSIST_CONFIG_PATH: configPath,
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: apiToken,
    CONNECTOR_HEALTH_INTERVAL_MS: "10000",
  }))
    vi.stubEnv(key, value);
  for (const key of ["POSTGRES_URL", "DATABASE_URL", "ELIZA_CLOUD_PROVISIONED"])
    vi.stubEnv(key, undefined);
  // The first runtime has no Slack service; the runtime that replaces it does.
  first = await createTestRuntime({ characterName: "HealthBeforeSwap" });
  second = await createTestRuntime({ characterName: "HealthAfterSwap" });
  await second.runtime.registerService(SlackConnectorService);
  await second.runtime.getServiceLoadPromise("slack");
  server = await startApiServer({ port: 0, runtime: first.runtime });
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (first) await first.cleanup();
  if (second) await second.cleanup();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

async function slackHealth(): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/health`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const body = (await response.json()) as {
    connectors?: Record<string, string>;
  };
  return body.connectors?.slack;
}

it("checks the connectors of the new runtime after an in-process swap", async () => {
  await vi.waitFor(async () => expect(await slackHealth()).toBe("missing"), {
    timeout: 30_000,
    interval: 250,
  });

  server.updateRuntime(second.runtime);

  // The next 10 s check must read the new runtime, where Slack is running.
  await vi.waitFor(async () => expect(await slackHealth()).toBe("ok"), {
    timeout: 25_000,
    interval: 500,
  });
}, 90_000);
