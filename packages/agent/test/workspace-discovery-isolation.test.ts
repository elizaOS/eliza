/** Real filesystem and registry-cache isolation without external registry traffic. */
import fs, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveElizaConfig } from "../src/config/config.ts";
import {
  getRegistryPlugins,
  refreshRegistry,
  removeRegistryEndpoint,
} from "../src/services/registry-client.ts";
import { resolveWorkspaceRootsForDiscovery } from "../src/services/registry-client-local.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function workspace(parent: string, name: string) {
  const root = path.join(parent, name);
  const plugin = path.join(root, "plugins", `app-${name}`);
  await mkdir(plugin, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ private: true, workspaces: ["plugins/*"] }),
  );
  await writeFile(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: `@elizaos/app-${name}`,
      version: "1.0.0",
      description: name,
      elizaos: { kind: "app", app: { displayName: name, launchType: "url" } },
    }),
  );
  return root;
}
describe("workspace-bound plugin discovery", () => {
  it("does not borrow a sibling checkout when the caller cwd differs", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "eliza-discovery-roots-"));
    roots.push(parent);
    const owning = await workspace(parent, "owner-probe");
    const other = await workspace(parent, "sibling-probe");
    const moduleDir = path.join(owning, "packages/agent/src/services");
    await mkdir(moduleDir, { recursive: true });
    expect(
      resolveWorkspaceRootsForDiscovery({ moduleDir, cwd: other }),
    ).toEqual([owning]);
    expect(
      resolveWorkspaceRootsForDiscovery({
        moduleDir,
        cwd: owning,
        envRoot: other,
      }),
    ).toEqual([other]);
  });
  it("does not reuse another explicit workspace's cached catalog", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "eliza-discovery-cache-"));
    roots.push(parent);
    const first = await workspace(parent, "scope-a-probe");
    const second = await workspace(parent, "scope-b-probe");
    vi.stubEnv("ELIZA_STATE_DIR", path.join(parent, "state"));
    vi.stubGlobal("fetch", async () => {
      throw new Error("Network disabled in registry isolation test");
    });
    vi.stubEnv("ELIZA_WORKSPACE_ROOT", first);
    expect((await getRegistryPlugins()).has("@elizaos/app-scope-a-probe")).toBe(
      true,
    );
    vi.stubEnv("ELIZA_WORKSPACE_ROOT", second);
    const switched = await getRegistryPlugins();
    expect(switched.has("@elizaos/app-scope-b-probe")).toBe(true);
    expect(switched.has("@elizaos/app-scope-a-probe")).toBe(false);
    vi.stubEnv("ELIZA_WORKSPACE_ROOT", first);
    const restored = await getRegistryPlugins();
    expect(restored.has("@elizaos/app-scope-a-probe")).toBe(true);
    expect(restored.has("@elizaos/app-scope-b-probe")).toBe(false);
  });
});

it("detaches an in-flight registry load when an endpoint is removed", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "eliza-endpoint-cache-"));
  roots.push(parent);
  const root = await workspace(parent, "endpoint-probe");
  const state = path.join(parent, "state");
  vi.stubEnv("ELIZA_STATE_DIR", state);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(state, "eliza.json"));
  vi.stubEnv("ELIZA_WORKSPACE_ROOT", root);
  vi.stubGlobal("fetch", async () => {
    throw new Error("Network disabled in registry isolation test");
  });
  saveElizaConfig({
    plugins: {
      registryEndpoints: [
        {
          label: "disabled fixture",
          url: "https://registry.example.test",
          enabled: false,
        },
      ],
    },
  });
  const originalRead = fs.readFile.bind(fs);
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  let held = false;
  vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    if (
      String(args[0]) === path.join(state, "cache", "registry.json") &&
      !held
    ) {
      held = true;
      readStarted();
      await readGate;
    }
    return originalRead(...args);
  });
  const staleLoad = getRegistryPlugins();
  await started;
  removeRegistryEndpoint("https://registry.example.test");
  let current: Awaited<ReturnType<typeof getRegistryPlugins>> | undefined;
  const freshLoad = getRegistryPlugins().then((plugins) => {
    current = plugins;
    return plugins;
  });
  try {
    await vi.waitFor(() => expect(current).toBeDefined());
  } finally {
    releaseRead();
    await Promise.all([staleLoad, freshLoad]);
  }
  expect(await getRegistryPlugins()).toBe(current);
});

it("does not let delayed refresh cleanup invalidate a newer workspace snapshot", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "eliza-refresh-scope-"));
  roots.push(parent);
  const first = await workspace(parent, "refresh-first-probe");
  const second = await workspace(parent, "refresh-second-probe");
  const state = path.join(parent, "state");
  vi.stubEnv("ELIZA_STATE_DIR", state);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(state, "eliza.json"));
  vi.stubEnv("ELIZA_WORKSPACE_ROOT", first);
  vi.stubGlobal("fetch", async () => {
    throw new Error("Network disabled in registry isolation test");
  });
  let releaseUnlink!: () => void;
  const unlinkGate = new Promise<void>((resolve) => {
    releaseUnlink = resolve;
  });
  let unlinkStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    unlinkStarted = resolve;
  });
  const originalUnlink = fs.unlink.bind(fs);
  vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
    if (String(file) === path.join(state, "cache", "registry.json")) {
      unlinkStarted();
      await unlinkGate;
    }
    return originalUnlink(file);
  });
  const oldRefresh = refreshRegistry();
  await started;
  vi.stubEnv("ELIZA_WORKSPACE_ROOT", second);
  const current = await getRegistryPlugins();
  releaseUnlink();
  await oldRefresh;
  expect(current.has("@elizaos/app-refresh-second-probe")).toBe(true);
  expect(await getRegistryPlugins()).toBe(current);
});
