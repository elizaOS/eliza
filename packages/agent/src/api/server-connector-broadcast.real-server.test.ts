import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ConnectorSetupService } from "../services/connector-setup-service.ts";
import { startApiServer } from "./server.ts";

const originalEnv = new Map<string, string | undefined>();
const runtimes: AgentRuntime[] = [];
let stateDir: string;
let api: Awaited<ReturnType<typeof startApiServer>> | undefined;
let ws: WebSocket | undefined;

beforeEach(async () => {
  for (const key of [
    "ELIZA_STATE_DIR",
    "ELIZA_CONFIG_PATH",
    "ELIZA_PERSIST_CONFIG_PATH",
    "ELIZA_API_BIND_HOST",
    "ELIZA_API_TOKEN",
    "ELIZA_API_AUTH_TOKEN",
    "ELIZA_CLOUD_PROVISIONED",
    "ELIZA_REQUIRE_LOCAL_AUTH",
    "ELIZA_PORT",
    "ELIZA_API_PORT",
  ])
    originalEnv.set(key, process.env[key]);
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-connector-broadcast-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_PERSIST_CONFIG_PATH = process.env.ELIZA_CONFIG_PATH;
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = "connector-broadcast-test";
  delete process.env.ELIZA_API_AUTH_TOKEN;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
});

afterEach(async () => {
  ws?.terminate();
  ws = undefined;
  await api?.close();
  api = undefined;
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop({ fast: true });
    await runtime.close();
  }
  await rm(stateDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
}, 30_000);

async function createRuntime() {
  const runtime = new AgentRuntime({ logLevel: "fatal", plugins: [] });
  runtimes.push(runtime);
  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
  await runtime.registerService(ConnectorSetupService);
  expect(runtime.getService("connector-setup")).toBeNull();
  return runtime;
}

it("binds lazy connector broadcasts on boot and swap, and detaches the old runtime", async () => {
  const runtime = await createRuntime();
  api = await startApiServer({
    port: 0,
    runtime,
    skipDeferredStartupWork: true,
  });
  ws = new WebSocket(`ws://127.0.0.1:${api.port}/ws`, {
    headers: { Authorization: "Bearer connector-broadcast-test" },
  });
  const received: unknown[] = [];
  ws.on("message", (data) => received.push(JSON.parse(data.toString())));
  await once(ws, "open", { signal: AbortSignal.timeout(5_000) });

  const service = (await runtime.getServiceLoadPromise(
    "connector-setup",
  )) as ConnectorSetupService;
  const beforeSwap = {
    type: "view:event",
    viewEventType: "notes:state-updated",
    payload: { revision: 1 },
  };
  service.broadcastWs(beforeSwap);
  await vi.waitFor(() => expect(received).toContainEqual(beforeSwap));

  const replacement = await createRuntime();
  api.updateRuntime(replacement);
  const nextService = (await replacement.getServiceLoadPromise(
    "connector-setup",
  )) as ConnectorSetupService;
  const stale = {
    type: "view:event",
    viewEventType: "notes:state-updated",
    payload: { revision: 2 },
  };
  const afterSwap = {
    type: "view:event",
    viewEventType: "notes:state-updated",
    payload: { revision: 3 },
  };
  service.broadcastWs(stale);
  nextService.broadcastWs(afterSwap);
  await vi.waitFor(() => expect(received).toContainEqual(afterSwap));
  expect(received).not.toContainEqual(stale);

  const detach = vi.spyOn(nextService, "setBroadcastWs");
  ws.terminate();
  ws = undefined;
  await api.close();
  api = undefined;
  expect(detach).toHaveBeenCalledWith(null);
}, 60_000);
