import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRemotePluginPayload,
  buildRemotePluginRuntimeContext,
  ensureRemotePluginSourceDirectory,
  getRemotePluginStorePaths,
  installPrebuiltRemotePlugin,
  loadInstalledRemotePlugin,
  loadInstalledRemotePlugins,
  loadRemotePluginListEntries,
  loadRemotePluginStoreSnapshot,
  RemotePluginStoreError,
  readRemotePluginRegistry,
  resolveRemotePluginPathInside,
  toRemotePluginViewUrl,
  uninstallInstalledRemotePlugin,
} from "./store.js";
import type { RemotePluginManifest } from "./types.js";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "plugin-remote-manifest-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const manifest: RemotePluginManifest = {
  id: "bunny.search",
  name: "Search",
  version: "1.0.0",
  description: "Search helper",
  mode: "window",
  permissions: {
    host: { windows: true },
    bun: { read: true },
    isolation: "shared-worker",
  },
  view: {
    relativePath: "views/index.html",
    title: "Search",
    width: 720,
    height: 480,
  },
  worker: {
    relativePath: "worker.js",
  },
  remoteUIs: {
    dash: {
      name: "Dashboard",
      path: "remote-ui/dash/index.html",
    },
  },
};

function writePayload(
  dir: string,
  nextManifest: RemotePluginManifest = manifest,
): string {
  const payloadDir = join(dir, "payload");
  mkdirSync(join(payloadDir, "views"), { recursive: true });
  writeFileSync(
    join(payloadDir, "plugin.json"),
    JSON.stringify(nextManifest, null, 2),
    "utf8",
  );
  writeFileSync(
    join(payloadDir, "worker.js"),
    "globalThis.postMessage({ type: 'ready' });\n",
    "utf8",
  );
  writeFileSync(
    join(payloadDir, "views", "index.html"),
    "<main>Search</main>\n",
    "utf8",
  );
  mkdirSync(join(payloadDir, "remote-ui", "dash"), { recursive: true });
  writeFileSync(
    join(payloadDir, "remote-ui", "dash", "index.html"),
    "<main>Dashboard</main>\n",
    "utf8",
  );
  return payloadDir;
}

describe("remote plugin store", () => {
  it("installs a prebuilt remote plugin and writes a registry", () =>
    withTempDir((dir) => {
      const storeRoot = join(dir, "store");
      const payloadDir = writePayload(dir);

      const installed = installPrebuiltRemotePlugin(storeRoot, payloadDir, {
        now: () => 1700000000000,
      });

      expect(installed.manifest.id).toBe("bunny.search");
      expect(installed.viewUrl).toBe("views://views/index.html");
      expect(installed.install.permissionsGranted).toEqual({
        host: { windows: true },
        bun: { read: true },
        isolation: "shared-worker",
      });
      expect(
        installed.workerPath.endsWith(".bunny/plugin-bun-entrypoint.mjs"),
      ).toBe(true);

      const registry = readRemotePluginRegistry(storeRoot);
      expect(Object.keys(registry.remotePlugins)).toEqual(["bunny.search"]);
      expect(registry.remotePlugins["bunny.search"]?.installedAt).toBe(
        1700000000000,
      );
    }));

  it("loads installed remote plugins and preserves the bootstrap context", () =>
    withTempDir((dir) => {
      const storeRoot = join(dir, "store");
      const payloadDir = writePayload(dir);
      installPrebuiltRemotePlugin(storeRoot, payloadDir, {
        now: () => 1700000000000,
      });

      const loaded = loadInstalledRemotePlugin(storeRoot, "bunny.search");
      expect(loaded?.manifest.remoteUIs?.dash?.path).toBe(
        "remote-ui/dash/index.html",
      );
      expect(loaded?.workerPath).toBe(
        join(loaded?.currentDir ?? "", ".bunny", "plugin-bun-entrypoint.mjs"),
      );

      const all = loadInstalledRemotePlugins(storeRoot);
      expect(all.map((remotePlugin) => remotePlugin.manifest.id)).toEqual([
        "bunny.search",
      ]);
      if (!loaded) throw new Error("Expected remote plugin to load.");
      const bootstrap = readFileSync(loaded.workerPath, "utf8");
      expect(bootstrap).toContain('"authToken":null');
      expect(bootstrap).toContain('"channel":"remote-plugin:bunny.search"');
    }));

  it("builds a complete remote plugin runtime context", () =>
    withTempDir((dir) => {
      expect(
        buildRemotePluginRuntimeContext(
          join(dir, "current"),
          join(dir, "state"),
          "bunny.search",
          { host: { windows: true }, bun: { read: true } },
          "token-1",
        ),
      ).toEqual({
        currentDir: join(dir, "current"),
        statePath: join(dir, "state", "state.json"),
        logsPath: join(dir, "state", "logs.txt"),
        permissions: ["host:windows", "bun:read", "isolation:shared-worker"],
        grantedPermissions: {
          host: { windows: true },
          bun: { read: true },
          isolation: "shared-worker",
        },
        authToken: "token-1",
        channel: "remote-plugin:bunny.search",
      });
    }));

  it("builds a public store snapshot for host and UI callers", () =>
    withTempDir((dir) => {
      const storeRoot = join(dir, "store");
      const payloadDir = writePayload(dir);
      installPrebuiltRemotePlugin(storeRoot, payloadDir, {
        currentHash: "hash-1",
        devMode: true,
        lastBuildAt: 1700000000100,
        now: () => 1700000000000,
      });

      const snapshot = loadRemotePluginStoreSnapshot(storeRoot);

      expect(snapshot).toMatchObject({
        version: 1,
        remotePlugins: [
          {
            id: "bunny.search",
            name: "Search",
            version: "1.0.0",
            description: "Search helper",
            mode: "window",
            status: "installed",
            sourceKind: "artifact",
            currentHash: "hash-1",
            installedAt: 1700000000000,
            updatedAt: 1700000000000,
            devMode: true,
            lastBuildAt: 1700000000100,
            lastBuildError: null,
            requestedPermissions: {
              host: { windows: true },
              bun: { read: true },
              isolation: "shared-worker",
            },
            grantedPermissions: {
              host: { windows: true },
              bun: { read: true },
              isolation: "shared-worker",
            },
            view: {
              relativePath: "views/index.html",
              viewUrl: "views://views/index.html",
              title: "Search",
              width: 720,
              height: 480,
            },
            worker: {
              relativePath: "worker.js",
            },
            remoteUIs: {
              dash: {
                name: "Dashboard",
                path: "remote-ui/dash/index.html",
              },
            },
          },
        ],
      });
      expect(JSON.stringify(snapshot)).not.toContain(storeRoot);
    }));

  it("builds compact list entries from installed remote plugins", () =>
    withTempDir((dir) => {
      const storeRoot = join(dir, "store");
      const payloadDir = writePayload(dir);
      installPrebuiltRemotePlugin(storeRoot, payloadDir, {
        devMode: true,
        now: () => 1700000000000,
      });

      expect(loadRemotePluginListEntries(storeRoot)).toEqual([
        {
          id: "bunny.search",
          name: "Search",
          description: "Search helper",
          version: "1.0.0",
          mode: "window",
          permissions: ["host:windows", "bun:read", "isolation:shared-worker"],
          status: "installed",
          devMode: true,
        },
      ]);
    }));

  it("rejects payload paths that escape the remote plugin root", () =>
    withTempDir((dir) => {
      const escapedManifest: RemotePluginManifest = {
        ...manifest,
        worker: { relativePath: "../worker.js" },
      };
      const payloadDir = writePayload(dir, escapedManifest);

      expect(() => assertRemotePluginPayload(payloadDir)).toThrow(
        RemotePluginStoreError,
      );
      expect(() =>
        resolveRemotePluginPathInside(payloadDir, "../worker.js"),
      ).toThrow(RemotePluginStoreError);
      expect(() =>
        resolveRemotePluginPathInside(payloadDir, "/worker.js"),
      ).toThrow(RemotePluginStoreError);
      expect(() =>
        resolveRemotePluginPathInside(payloadDir, "views//index.html"),
      ).toThrow(RemotePluginStoreError);
    }));

  it("builds view URLs only from safe relative paths", () => {
    expect(toRemotePluginViewUrl("views/index.html")).toBe(
      "views://views/index.html",
    );

    for (const unsafePath of [
      "",
      ".",
      "..",
      "../view.html",
      "/view.html",
      "views//index.html",
      "C:\\view.html",
    ]) {
      expect(() => toRemotePluginViewUrl(unsafePath)).toThrow(
        RemotePluginStoreError,
      );
    }
  });

  it("rejects payloads with missing worker or view files", () =>
    withTempDir((dir) => {
      const missingWorkerPayload = writePayload(dir);
      rmSync(join(missingWorkerPayload, "worker.js"));
      expect(() => assertRemotePluginPayload(missingWorkerPayload)).toThrow(
        /Missing worker for bunny\.search/,
      );

      const missingViewPayload = writePayload(join(dir, "second"));
      rmSync(join(missingViewPayload, "views", "index.html"));
      expect(() => assertRemotePluginPayload(missingViewPayload)).toThrow(
        /Missing view entry for bunny\.search/,
      );
    }));

  it("rejects remote UI paths that escape or point at missing files", () =>
    withTempDir((dir) => {
      const escapedManifest: RemotePluginManifest = {
        ...manifest,
        remoteUIs: {
          dash: { name: "Dashboard", path: "../dash.html" },
        },
      };
      const escapedPayload = writePayload(dir, escapedManifest);
      expect(() => assertRemotePluginPayload(escapedPayload)).toThrow(
        RemotePluginStoreError,
      );

      const missingManifest: RemotePluginManifest = {
        ...manifest,
        remoteUIs: {
          missing: { name: "Missing", path: "remote-ui/missing/index.html" },
        },
      };
      const missingPayload = writePayload(join(dir, "second"), missingManifest);
      expect(() => assertRemotePluginPayload(missingPayload)).toThrow(
        /Missing remote UI missing for bunny\.search/,
      );
    }));

  it("rejects remote plugin ids before deriving store paths", () =>
    withTempDir((dir) => {
      expect(() =>
        getRemotePluginStorePaths(join(dir, "store"), "../../evil"),
      ).toThrow(RemotePluginStoreError);
    }));

  it("uninstalls a remote plugin and refreshes the registry", () =>
    withTempDir((dir) => {
      const storeRoot = join(dir, "store");
      const payloadDir = writePayload(dir);
      installPrebuiltRemotePlugin(storeRoot, payloadDir);

      const removed = uninstallInstalledRemotePlugin(storeRoot, "bunny.search");
      expect(removed?.id).toBe("bunny.search");
      expect(readRemotePluginRegistry(storeRoot).remotePlugins).toEqual({});
      expect(loadInstalledRemotePlugin(storeRoot, "bunny.search")).toBeNull();
    }));

  it("recognizes source directories", () =>
    withTempDir((dir) => {
      const sourceDir = join(dir, "source");
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(
        join(sourceDir, "electrobun.config.ts"),
        "export default {};\n",
        "utf8",
      );

      expect(ensureRemotePluginSourceDirectory(sourceDir)).toBe(sourceDir);
      expect(getRemotePluginStorePaths(dir, "bunny.search").installPath).toBe(
        join(dir, "bunny.search", "install.json"),
      );
    }));
});
