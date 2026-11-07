import { once } from "node:events";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { startEliza } from "@elizaos/agent/runtime/eliza";
import {
  getAgentHostBridge,
  setAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import { createTestVault, type TestVault } from "@elizaos/auth/testing";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { _resetSharedVaultForTesting } from "../services/vault-mirror";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleSecretsInventoryRoute } from "./secrets-inventory-routes";

const API_TOKEN = "inventory-route-test-token";
const PERSONAL_KEY = "openai-personal-profile-placeholder";
const WORK_KEY = "openai-work-profile-placeholder";

let stateDir: string;
let testVault: TestVault;
let server: Server;
let origin: string;
const savedBridge = getAgentHostBridge();

beforeEach(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-profile-boot-"));
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(stateDir, "eliza.json"));
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(stateDir, "eliza.json"));
  vi.stubEnv("PGLITE_DATA_DIR", path.join(stateDir, "db"));
  vi.stubEnv("ELIZA_API_TOKEN", API_TOKEN);
  for (const key of [
    "OPENAI_API_KEY",
    "POSTGRES_URL",
    "DATABASE_URL",
    "SANDBOX_ROUTE_AGENT_ID",
  ])
    vi.stubEnv(key, undefined);
  testVault = await createTestVault({ workDir: stateDir });
  _resetSharedVaultForTesting(testVault.vault);
  setAgentHostBridge({ ...savedBridge, sharedVault: () => testVault.vault });
  const routeState: CompatRuntimeState = {
    current: null,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleSecretsInventoryRoute(
      req,
      res,
      url.pathname,
      req.method ?? "GET",
      routeState,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.close();
  setAgentHostBridge(savedBridge);
  _resetSharedVaultForTesting(null);
  await testVault.dispose();
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function callRoute(
  method: string,
  pathname: string,
  body: unknown,
): Promise<number> {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.status;
}

async function bootRuntimeSettings(): Promise<AgentRuntime> {
  const abort = new AbortController();
  let created: AgentRuntime | undefined;
  await startEliza({
    headless: true,
    abortSignal: abort.signal,
    onRuntimeCreated: (runtime) => {
      created = runtime as AgentRuntime;
      abort.abort();
    },
  }).catch((err: unknown) => {
    if (!created) throw err;
  });
  if (!created) throw new Error("runtime was not created");
  return created;
}

it("boots the agent with the vault profile the user switched to", async () => {
  await testVault.vault.set("OPENAI_API_KEY", PERSONAL_KEY, {
    sensitive: true,
  });
  fs.writeFileSync(
    path.join(stateDir, "eliza.json"),
    JSON.stringify({ env: { OPENAI_API_KEY: "vault://OPENAI_API_KEY" } }),
  );
  expect(
    await callRoute("POST", "/api/secrets/inventory/migrate-to-profiles", {
      key: "OPENAI_API_KEY",
    }),
  ).toBe(200);
  expect(
    await callRoute("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
      id: "work",
      label: "Work",
      value: WORK_KEY,
    }),
  ).toBe(200);
  expect(
    await callRoute(
      "PUT",
      "/api/secrets/inventory/OPENAI_API_KEY/active-profile",
      { profileId: "work" },
    ),
  ).toBe(200);

  const runtime = await bootRuntimeSettings();

  expect(runtime.getSetting("OPENAI_API_KEY")).toBe(WORK_KEY);
}, 300_000);
