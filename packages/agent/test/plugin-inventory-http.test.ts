/** Real authenticated HTTP inventory, disk config reload, and runtime registration. */

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRuntime } from "@elizaos/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { discoverPluginsFromManifest } from "../src/api/plugin-discovery-helpers.ts";
import { handlePluginInventoryRoutes } from "../src/api/plugin-inventory-routes.ts";
import { startApiServer } from "../src/api/server.ts";
import type { PluginEntry } from "../src/api/server-types.ts";

let directory: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
const token = randomUUID();
const secret = "synthetic-inventory-secret-please-never-return";
let configPath: string;
let installPath: string;
async function persist(enabled: boolean, key: string) {
  await writeFile(
    configPath,
    JSON.stringify({
      plugins: {
        entries: {
          "inventory-e2e": {
            enabled,
            config: { INVENTORY_API_KEY: key, INVENTORY_ACCESS_TOKEN: key },
          },
          pdf: { enabled: false },
        },
        installs: {
          "@inventory/plugin-inventory-e2e": {
            source: "path",
            installPath,
            version: "1.0.0",
          },
        },
      },
    }),
  );
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-inventory-http-"));
  configPath = path.join(directory, "eliza.json");
  installPath = path.join(directory, "installed");
  await mkdir(installPath);
  await writeFile(
    path.join(installPath, "package.json"),
    JSON.stringify({
      name: "@inventory/plugin-inventory-e2e",
      version: "1.0.0",
      description: "Synthetic inventory acceptance plugin",
      agentConfig: {
        pluginParameters: {
          INVENTORY_ACCESS_TOKEN: { type: "string", sensitive: false },
          INVENTORY_API_KEY: {
            type: "string",
            sensitive: true,
            required: true,
          },
        },
      },
    }),
  );
  await persist(true, secret);
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: configPath,
    ELIZA_PERSIST_CONFIG_PATH: configPath,
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  fixture = await createTestRuntime({
    characterName: "InventoryHttpAcceptance",
    plugins: [
      {
        name: "inventory-runtime-only",
        description: "Synthetic runtime registration",
      },
    ],
  });
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
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

function request(route = "/api/plugins", authenticated = true) {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    headers: {
      "x-forwarded-for": "203.0.113.10",
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

it("lists the complete catalog and loaded registrations with fresh redacted configuration behind authentication", async () => {
  expect((await request("/api/plugins", false)).status).toBe(401);
  expect((await request("/api/plugins/core", false)).status).toBe(401);
  const response = await request();
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(secret);
  const { plugins } = JSON.parse(text) as { plugins: PluginEntry[] };
  const ids = new Set(plugins.map((entry) => entry.id));
  for (const entry of discoverPluginsFromManifest())
    expect(ids.has(entry.id)).toBe(true);
  expect(
    plugins.find((entry) => entry.id === "inventory-runtime-only"),
  ).toMatchObject({ enabled: true, isActive: true });
  expect(plugins.find((entry) => entry.id === "inventory-e2e")).toMatchObject({
    enabled: true,
    isActive: false,
    configured: true,
  });
  const installed = plugins.find((entry) => entry.id === "inventory-e2e");
  expect(
    installed?.parameters.find(
      (parameter) => parameter.key === "INVENTORY_ACCESS_TOKEN",
    ),
  ).toMatchObject({ sensitive: true, isSet: true, currentValue: "****" });
  expect(
    installed?.parameters.find(
      (parameter) => parameter.key === "INVENTORY_API_KEY",
    ),
  ).toMatchObject({ sensitive: true, isSet: true, currentValue: "****" });
  await persist(false, "");
  server.reloadConfigFromDisk();
  const updated = (await (await request()).json()) as {
    plugins: PluginEntry[];
  };
  expect(
    updated.plugins.find((entry) => entry.id === "inventory-e2e"),
  ).toMatchObject({
    enabled: false,
    isActive: false,
    configured: false,
  });
  expect(
    updated.plugins
      .find((entry) => entry.id === "inventory-e2e")
      ?.parameters.every(
        (parameter) => !parameter.isSet && parameter.currentValue === null,
      ),
  ).toBe(true);
  const coreResponse = await request("/api/plugins/core");
  expect(coreResponse.status).toBe(200);
  const core = (await coreResponse.json()) as {
    core: unknown[];
    optional: Array<{ id: string; enabled: boolean; loaded: boolean }>;
  };
  expect(core.core.length).toBeGreaterThan(0);
  expect(core.optional.find((entry) => entry.id === "pdf")).toMatchObject({
    enabled: false,
    loaded: false,
  });
}, 120_000);

it("preserves failed registration diagnostics across catalog refresh without leaking raw errors", async () => {
  const catalog = discoverPluginsFromManifest();
  const failed = catalog.find((entry) => entry.id === "pdf");
  expect(failed).toBeDefined();
  if (!failed) throw new Error("PDF must be present in the catalog");
  const state = {
    config: {},
    runtime: fixture.runtime,
    plugins: [{ ...failed, loadError: `Load rejected credential ${secret}` }],
  };
  const listener = createServer((req, res) => {
    if (
      !handlePluginInventoryRoutes({
        method: req.method ?? "",
        pathname: req.url ?? "",
        res,
        state,
        json: (response, data) => {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(data));
        },
      })
    ) {
      res.statusCode = 404;
      res.end();
    }
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP address unavailable");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/plugins`,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(secret);
    const result = JSON.parse(text) as { plugins: PluginEntry[] };
    expect(
      result.plugins.find((entry) => entry.id === failed.id),
    ).toMatchObject({
      isActive: false,
      loadError: "Plugin failed to load; inspect host diagnostics",
    });
    await fixture.runtime.registerPlugin({
      name: failed.id,
      description: "Synthetic successful retry",
    });
    const retried = (await (
      await fetch(`http://127.0.0.1:${address.port}/api/plugins`)
    ).json()) as { plugins: PluginEntry[] };
    expect(
      retried.plugins.find((entry) => entry.id === failed.id)?.isActive,
    ).toBe(true);
    expect(
      retried.plugins.find((entry) => entry.id === failed.id)?.loadError,
    ).toBeUndefined();
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
