/** Real CLI host composition, HTTP admission and durable per-agent selection on PGlite. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHttpPluginRoutes } from "@elizaos/core";
import type { BrowserService } from "@elizaos/plugin-browser";
import { createTestRuntime } from "@elizaos/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { nativeDeviceBrowserStatusRoute } from "../../../plugins/plugin-browser/src/routes/native-device.ts";
import { startApiServer } from "../src/api/server.ts";
import { initializeManagedBrowserHost } from "../src/runtime/managed-browser-host.ts";

let directory: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
const token = randomUUID(),
  ownerId = randomUUID(),
  name = randomUUID();
async function boot() {
  fixture = await createTestRuntime({
    characterName: name,
    pgliteDir: path.join(directory, "db"),
    removePgliteDirOnCleanup: false,
    settings: { LOAD_DOCS_ON_STARTUP: false },
  });
  await initializeManagedBrowserHost(fixture.runtime, {});
  expect(fixture.runtime.getService("browser")).toBeNull();
  registerHttpPluginRoutes(fixture.runtime, {
    name: "native-status",
    description: "Native browser status before managed host initialization",
    routes: [nativeDeviceBrowserStatusRoute],
  });
  server = await startApiServer({
    port: 0,
    runtime: fixture.runtime,
    skipDeferredStartupWork: true,
  });
  const preBoot = await fetch(
    `http://127.0.0.1:${server.port}/api/browser-device`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  expect(preBoot.status).toBe(503);
  await initializeManagedBrowserHost(fixture.runtime, {
    ELIZA_RUNTIME_OWNER_ID: ownerId,
  });
}
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-managed-browser-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
    ELIZA_PLUGIN_SET: "lean-chat",
  }))
    vi.stubEnv(key, value);
  for (const key of ["POSTGRES_URL", "DATABASE_URL", "ELIZA_CLOUD_PROVISIONED"])
    vi.stubEnv(key, undefined);
  await boot();
}, 120_000);
afterAll(async () => {
  if (server) await server.close();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);
function status(authenticated = true) {
  return fetch(`http://127.0.0.1:${server.port}/api/remote-browser/status`, {
    headers: {
      "x-forwarded-for": "203.0.113.10",
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
it("provides owner-only pairing routes without local browser targets and preserves selection refusal across restart", async () => {
  const browser = fixture.runtime.getService<BrowserService>("browser");
  expect(browser?.listTargets()).toEqual([]);
  expect(browser?.getNativeDeviceStatus()).toEqual({ connected: false });
  expect((await status(false)).status).toBe(401);
  const response = await status();
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({ configured: false });
  // A local API owner identity and the provisioning Cloud owner are different
  // identity realms; possession of the owner API token remains valid admission.
  expect(fixture.runtime.agentId).not.toBe(ownerId);
  await fixture.runtime.setCache("browser.search-profile", { disabled: true });
  await server.close();
  await fixture.cleanup();
  await boot();
  expect(await fixture.runtime.getCache("browser.search-profile")).toEqual({
    disabled: true,
  });
  expect(
    fixture.runtime.getService<BrowserService>("browser")?.listTargets(),
  ).toEqual([]);
  expect((await status()).status).toBe(200);
}, 120_000);
