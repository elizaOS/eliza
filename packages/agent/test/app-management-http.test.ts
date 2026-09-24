/** Real host HTTP and persisted state: restored app APIs keep auth and package identity. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRuntime } from "@elizaos/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { calendarPlugin } from "../../../plugins/plugin-calendar/src/plugin.ts";
import { startApiServer } from "../src/api/server.ts";

const token = randomUUID();
const initialCwd = process.cwd();
let directory: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-app-http-"));
  for (const [folder, name] of [
    ["workspace", "override-probe"],
    ["sibling", "sibling-probe"],
  ]) {
    const root = path.join(directory, folder);
    const app = path.join(root, "plugins", `app-${name}`);
    await mkdir(app, { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["plugins/*"] }),
    );
    await writeFile(
      path.join(app, "package.json"),
      JSON.stringify({
        name: `@elizaos/app-${name}`,
        version: "1.0.0",
        elizaos: { kind: "app", app: { displayName: name, launchType: "url" } },
      }),
    );
  }
  const installed = path.join(
    directory,
    "plugins/installed/probe/node_modules/@elizaos/app-installed-probe",
  );
  await mkdir(installed, { recursive: true });
  await writeFile(
    path.join(installed, "package.json"),
    JSON.stringify({
      name: "@elizaos/app-installed-probe",
      version: "1.0.0",
      elizaos: {
        kind: "app",
        app: { displayName: "Installed probe", launchType: "url" },
      },
    }),
  );
  process.chdir(path.join(directory, "workspace"));
  vi.stubEnv("ELIZA_WORKSPACE_ROOT", undefined);

  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  for (const key of ["POSTGRES_URL", "DATABASE_URL", "ELIZA_CLOUD_PROVISIONED"])
    vi.stubEnv(key, undefined);
  fixture = await createTestRuntime({
    characterName: "AppManagementHttp",
    pgliteDir: path.join(directory, "db"),
    settings: { LOAD_DOCS_ON_STARTUP: false },
    plugins: [calendarPlugin],
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
  process.chdir(initialCwd);
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

it("serves catalogs, rejects anonymous launch, launches an already loaded package and persists favorites", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  for (const route of [
    "/api/plugins",
    "/api/apps",
    "/api/apps/installed",
    "/api/apps/runs",
  ]) {
    const response = await fetch(base + route, { headers });
    expect(response.status, await response.clone().text()).toBe(200);
    const payload = await response.json();
    expect(payload).toBeDefined();
    if (route === "/api/apps") {
      expect(payload.map((app: { name: string }) => app.name)).toContain(
        "@elizaos/app-installed-probe",
      );
      expect(payload.map((app: { name: string }) => app.name)).not.toContain(
        "@elizaos/app-sibling-probe",
      );
      expect(payload.map((app: { name: string }) => app.name)).not.toContain(
        "@elizaos/app-override-probe",
      );
    }
  }
  const anonymous = await fetch(`${base}/api/apps/launch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "@elizaos/plugin-calendar" }),
  });
  expect(anonymous.status).toBe(401);
  const before = fixture.runtime.plugins.filter(
    (p) => p.name === calendarPlugin.name,
  ).length;
  const launch = await fetch(`${base}/api/apps/launch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "@elizaos/plugin-calendar" }),
  });
  expect(launch.status, await launch.clone().text()).toBe(200);
  expect(await launch.json()).toMatchObject({
    pluginInstalled: true,
    needsRestart: false,
    displayName: "Calendar",
    run: null,
  });
  expect(
    fixture.runtime.plugins.filter((p) => p.name === calendarPlugin.name),
  ).toHaveLength(before);
  const favorite = await fetch(`${base}/api/apps/favorites`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      appName: "@elizaos/plugin-calendar",
      isFavorite: true,
    }),
  });
  expect(favorite.status, await favorite.clone().text()).toBe(200);
  const config = JSON.parse(
    await readFile(path.join(directory, "eliza.json"), "utf8"),
  );
  expect(config.ui.favoriteApps).toContain("@elizaos/plugin-calendar");
}, 60_000);

it("honors an explicit workspace override without reusing another scope's catalog", async () => {
  const url = `http://127.0.0.1:${server.port}/api/apps`;
  const headers = { authorization: `Bearer ${token}` };
  vi.stubEnv("ELIZA_WORKSPACE_ROOT", path.join(directory, "workspace"));
  const overridden = await fetch(url, { headers });
  expect(overridden.status).toBe(200);
  const entries = await overridden.json();
  expect(entries.map((app: { name: string }) => app.name)).toContain(
    "@elizaos/app-installed-probe",
  );
  expect(entries.map((app: { name: string }) => app.name)).toContain(
    "@elizaos/app-override-probe",
  );
  expect(entries.map((app: { name: string }) => app.name)).not.toContain(
    "@elizaos/app-sibling-probe",
  );
  vi.stubEnv("ELIZA_WORKSPACE_ROOT", undefined);
  const restored = await fetch(url, { headers });
  expect(restored.status).toBe(200);
  expect(
    (await restored.json()).map((app: { name: string }) => app.name),
  ).not.toContain("@elizaos/app-override-probe");
}, 60_000);
