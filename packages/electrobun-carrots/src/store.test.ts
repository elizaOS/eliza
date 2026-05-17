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
  assertCarrotPayload,
  buildCarrotRuntimeContext,
  CarrotStoreError,
  ensureCarrotSourceDirectory,
  getCarrotStorePaths,
  installPrebuiltCarrot,
  loadCarrotListEntries,
  loadCarrotStoreSnapshot,
  loadInstalledCarrot,
  loadInstalledCarrots,
  readCarrotRegistry,
  resolveCarrotPathInside,
  uninstallInstalledCarrot,
} from "./store.js";
import type { CarrotManifest } from "./types.js";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "electrobun-carrots-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const manifest: CarrotManifest = {
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
  nextManifest: CarrotManifest = manifest,
): string {
  const payloadDir = join(dir, "payload");
  mkdirSync(join(payloadDir, "views"), { recursive: true });
  writeFileSync(
    join(payloadDir, "carrot.json"),
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
  return payloadDir;
}

describe("carrot store", () => {
  it("installs a prebuilt carrot and writes a registry", () =>
    withTempDir((dir) => {
      const storeRoot = join(dir, "store");
      const payloadDir = writePayload(dir);

      const installed = installPrebuiltCarrot(storeRoot, payloadDir, {
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
        installed.workerPath.endsWith(".bunny/carrot-bun-entrypoint.mjs"),
      ).toBe(true);

      const registry = readCarrotRegistry(storeRoot);
      expect(Object.keys(registry.carrots)).toEqual(["bunny.search"]);
      expect(registry.carrots["bunny.search"]?.installedAt).toBe(1700000000000);
    }));

  it("loads installed carrots and preserves the bootstrap context", () =>
    withTempDir((dir) => {
      const storeRoot = join(dir, "store");
      const payloadDir = writePayload(dir);
      installPrebuiltCarrot(storeRoot, payloadDir, {
        now: () => 1700000000000,
      });

      const loaded = loadInstalledCarrot(storeRoot, "bunny.search");
      expect(loaded?.manifest.remoteUIs?.dash?.path).toBe(
        "remote-ui/dash/index.html",
      );
      expect(loaded?.workerPath).toBe(
        join(loaded?.currentDir ?? "", ".bunny", "carrot-bun-entrypoint.mjs"),
      );

      const all = loadInstalledCarrots(storeRoot);
      expect(all.map((carrot) => carrot.manifest.id)).toEqual(["bunny.search"]);
      if (!loaded) throw new Error("Expected carrot to load.");
      const bootstrap = readFileSync(loaded.workerPath, "utf8");
      expect(bootstrap).toContain('"authToken":null');
      expect(bootstrap).toContain('"channel":"carrot:bunny.search"');
    }));

  it("builds a complete carrot runtime context", () =>
    withTempDir((dir) => {
      expect(
        buildCarrotRuntimeContext(
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
        channel: "carrot:bunny.search",
      });
    }));

  it("builds a public store snapshot for host and UI callers", () =>
    withTempDir((dir) => {
      const storeRoot = join(dir, "store");
      const payloadDir = writePayload(dir);
      installPrebuiltCarrot(storeRoot, payloadDir, {
        currentHash: "hash-1",
        devMode: true,
        lastBuildAt: 1700000000100,
        now: () => 1700000000000,
      });

      const snapshot = loadCarrotStoreSnapshot(storeRoot);

      expect(snapshot).toMatchObject({
        version: 1,
        carrots: [
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

  it("builds compact list entries from installed carrots", () =>
    withTempDir((dir) => {
      const storeRoot = join(dir, "store");
      const payloadDir = writePayload(dir);
      installPrebuiltCarrot(storeRoot, payloadDir, {
        devMode: true,
        now: () => 1700000000000,
      });

      expect(loadCarrotListEntries(storeRoot)).toEqual([
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

  it("rejects payload paths that escape the carrot root", () =>
    withTempDir((dir) => {
      const escapedManifest: CarrotManifest = {
        ...manifest,
        worker: { relativePath: "../worker.js" },
      };
      const payloadDir = writePayload(dir, escapedManifest);

      expect(() => assertCarrotPayload(payloadDir)).toThrow(CarrotStoreError);
      expect(() => resolveCarrotPathInside(payloadDir, "../worker.js")).toThrow(
        CarrotStoreError,
      );
    }));

  it("rejects carrot ids before deriving store paths", () =>
    withTempDir((dir) => {
      expect(() =>
        getCarrotStorePaths(join(dir, "store"), "../../evil"),
      ).toThrow(CarrotStoreError);
    }));

  it("uninstalls a carrot and refreshes the registry", () =>
    withTempDir((dir) => {
      const storeRoot = join(dir, "store");
      const payloadDir = writePayload(dir);
      installPrebuiltCarrot(storeRoot, payloadDir);

      const removed = uninstallInstalledCarrot(storeRoot, "bunny.search");
      expect(removed?.id).toBe("bunny.search");
      expect(readCarrotRegistry(storeRoot).carrots).toEqual({});
      expect(loadInstalledCarrot(storeRoot, "bunny.search")).toBeNull();
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

      expect(ensureCarrotSourceDirectory(sourceDir)).toBe(sourceDir);
      expect(getCarrotStorePaths(dir, "bunny.search").installPath).toBe(
        join(dir, "bunny.search", "install.json"),
      );
    }));
});
