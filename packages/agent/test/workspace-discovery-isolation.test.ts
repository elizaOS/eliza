/** Real filesystem and registry-cache isolation without external registry traffic. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRegistryPlugins } from "../src/services/registry-client.ts";
import { resolveWorkspaceRootsForDiscovery } from "../src/services/registry-client-local.ts";

const roots: string[] = [];
afterEach(async () => {
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
