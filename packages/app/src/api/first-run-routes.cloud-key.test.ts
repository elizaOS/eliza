import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadElizaConfig, saveElizaConfig } from "@elizaos/agent";
import { disconnectCloudConnection } from "@elizaos/plugin-elizacloud/lib/cloud-connection";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleFirstRunRoute } from "./first-run-routes";

let directory: string;
let configPath: string;
let server: http.Server;
let port: number;
const token = randomUUID();
const initialConfig = { agents: { list: [] } };
const state = {
  current: null,
  pendingAgentName: null,
  reloadConfigFromDisk: () => {},
} as unknown as CompatRuntimeState;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-app-first-run-"));
  configPath = path.join(directory, "eliza.json");
  await writeFile(configPath, JSON.stringify(initialConfig));
  for (const key of [
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZA_CLOUD_PROVISIONED",
    "ELIZA_DEV_CLOUD_TARGET",
    "ELIZA_DEV_CLOUD_API_KEY",
  ])
    vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: configPath,
    ELIZA_PERSIST_CONFIG_PATH: configPath,
    ELIZA_API_TOKEN: token,
  }))
    vi.stubEnv(key, value);
  server = http.createServer((req, res) => {
    void handleFirstRunRoute(req, res, state).then((handled) => {
      if (handled) return;
      res.statusCode = req.method === "PUT" ? 200 : 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing server port");
  }
  port = address.port;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  // Keep every delayed first-run callback inside the temporary config scope.
  await new Promise((resolve) => setTimeout(resolve, 3100));
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("rejects a local first-run that selects Eliza Cloud inference when the agent has no Cloud API key", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/first-run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "HybridNoKey",
      deploymentTarget: { runtime: "local", provider: "elizacloud" },
      serviceRouting: {
        llmText: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    }),
  });

  expect(response.status).toBe(409);
  expect((await response.json()).error).toContain("no Eliza Cloud API key");
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  expect(saved.meta?.firstRunComplete).toBeUndefined();
  expect(saved.serviceRouting).toBeUndefined();
});

it("accepts a supplied Cloud key and repairs a redacted write while the account remains linked", async () => {
  const cloudKey = "synthetic-cloud-inference-credential";
  const response = await fetch(`http://127.0.0.1:${port}/api/first-run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "HybridWithKey",
      deploymentTarget: { runtime: "local", provider: "elizacloud" },
      serviceRouting: {
        llmText: { backend: "elizacloud", transport: "cloud-proxy" },
      },
      credentialInputs: { cloudApiKey: cloudKey },
    }),
  });

  expect(response.status).toBe(200);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  expect(saved.meta.firstRunComplete).toBe(true);
  expect(saved.cloud.apiKey).toBe(cloudKey);
  expect(saved.serviceRouting.llmText).toMatchObject({
    backend: "elizacloud",
    transport: "cloud-proxy",
  });
  delete saved.cloud.apiKey;
  saveElizaConfig(saved);
  await new Promise((resolve) => setTimeout(resolve, 3100));
  expect(JSON.parse(await readFile(configPath, "utf8")).cloud.apiKey).toBe(
    cloudKey,
  );
}, 10000);

it("does not restore a Cloud key after the owner disconnects during the delayed resave", async () => {
  await writeFile(configPath, JSON.stringify(initialConfig));
  const response = await fetch(`http://127.0.0.1:${port}/api/first-run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "DisconnectDuringSetup",
      deploymentTarget: { runtime: "local", provider: "elizacloud" },
      serviceRouting: {
        llmText: { backend: "elizacloud", transport: "cloud-proxy" },
      },
      credentialInputs: { cloudApiKey: "synthetic-disconnected-cloud-key" },
    }),
  });
  expect(response.status).toBe(200);
  await disconnectCloudConnection({
    config: loadElizaConfig(),
    runtime: null,
    saveConfig: (config) =>
      saveElizaConfig(config as ReturnType<typeof loadElizaConfig>),
  });
  const disconnected = JSON.parse(await readFile(configPath, "utf8"));
  expect(disconnected.cloud?.apiKey).toBeUndefined();
  expect(disconnected.linkedAccounts.elizacloud.status).toBe("unlinked");
  await new Promise((resolve) => setTimeout(resolve, 3100));
  const settled = JSON.parse(await readFile(configPath, "utf8"));
  expect(settled.cloud?.apiKey).toBeUndefined();
  expect(settled.linkedAccounts.elizacloud.status).toBe("unlinked");
}, 10000);
