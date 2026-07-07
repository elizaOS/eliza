/**
 * Covers the cold-boot staging paths of importPluginModuleFromPath(): the
 * workspace in-place fast-path (no staging for plugins living inside a
 * workspace tree) and the content-keyed staging cache (deterministic
 * `content-<digest>` dirs reused across boots, atomically published, rebuilt
 * when corrupted, single-flight under concurrency — including a real
 * two-process race). Deterministic — real on-disk fixture packages under a
 * temp ELIZA_STATE_DIR, real subprocesses, no live model, no fs mocking.
 */
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  importPluginModuleFromPath,
  stageColdPluginImportRoot,
} from "./plugin-resolver.ts";

let tmpDir: string;
let stateDir: string;
const savedEnv: Record<string, string | undefined> = {};

function rememberEnv(key: string): void {
  savedEnv[key] = process.env[key];
}

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "plugin-resolver-stage-cache-"),
  );
  stateDir = path.join(tmpDir, "state");
  await fsp.mkdir(stateDir, { recursive: true });
  rememberEnv("ELIZA_STATE_DIR");
  rememberEnv("ELIZA_WORKSPACE_ROOT");
  process.env.ELIZA_STATE_DIR = stateDir;
  delete process.env.ELIZA_WORKSPACE_ROOT;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function sanitize(value: string): string {
  // Mirror sanitizePluginCacheSegment in plugin-resolver.ts.
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function stagingDirFor(packageName: string): string {
  return path.join(
    stateDir,
    "plugins",
    ".runtime-imports",
    sanitize(packageName),
  );
}

async function listStagingEntries(packageName: string): Promise<string[]> {
  try {
    return (await fsp.readdir(stagingDirFor(packageName))).sort();
  } catch {
    return [];
  }
}

/**
 * Create a git-layout, dist-less fixture package: `installPath` IS the package
 * root, entry is `index.mjs`. Dist-less on purpose — packages WITH dist take
 * the in-place fast-path and never reach the staging cache. The module exports
 * both a marker and its own import.meta.url so tests can assert WHERE the
 * module was loaded from, not just that it loaded.
 */
async function createSourceFixture(
  parentDir: string,
  packageName: string,
  marker: string,
): Promise<string> {
  const installPath = path.join(parentDir, sanitize(packageName));
  await fsp.mkdir(installPath, { recursive: true });
  await fsp.writeFile(
    path.join(installPath, "package.json"),
    JSON.stringify({ name: packageName, main: "index.mjs" }, null, 2),
  );
  await fsp.writeFile(
    path.join(installPath, "index.mjs"),
    `export const marker = ${JSON.stringify(marker)};\nexport const moduleUrl = import.meta.url;\n`,
  );
  return installPath;
}

function coldStageParams(installPath: string, packageName: string) {
  return {
    installRoot: installPath,
    packageRoot: installPath,
    packageRelativePath: [] as string[],
    packageName,
  };
}

describe("workspace in-place fast-path", () => {
  it("dist-less workspace plugin imports in place with NO staging", async () => {
    // A workspace tree: root node_modules farm + plugins/<pkg> source package.
    const workspaceRoot = path.join(tmpDir, "workspace");
    await fsp.mkdir(path.join(workspaceRoot, "node_modules"), {
      recursive: true,
    });
    process.env.ELIZA_WORKSPACE_ROOT = workspaceRoot;

    const name = "stage-cache-workspace-fixture";
    const installPath = await createSourceFixture(
      path.join(workspaceRoot, "plugins"),
      name,
      "ws-inplace",
    );

    const mod = (await importPluginModuleFromPath(installPath, name)) as {
      marker: string;
      moduleUrl: string;
    };

    expect(mod.marker).toBe("ws-inplace");
    // Loaded from the real workspace location, not a staged copy.
    expect(mod.moduleUrl).toContain(installPath);
    expect(await listStagingEntries(name)).toEqual([]);
  });

  it("dist-less workspace plugin WITHOUT a node_modules context still stages", async () => {
    // Same workspace containment, but no node_modules anywhere above the
    // package: in-place bare imports could not resolve, so staging must run.
    const workspaceRoot = path.join(tmpDir, "workspace-bare");
    await fsp.mkdir(workspaceRoot, { recursive: true });
    process.env.ELIZA_WORKSPACE_ROOT = workspaceRoot;

    const name = "stage-cache-workspace-bare-fixture";
    const installPath = await createSourceFixture(
      path.join(workspaceRoot, "plugins"),
      name,
      "ws-bare",
    );

    const mod = (await importPluginModuleFromPath(installPath, name)) as {
      marker: string;
      moduleUrl: string;
    };

    expect(mod.marker).toBe("ws-bare");
    expect(mod.moduleUrl).not.toContain(installPath);
    const entries = await listStagingEntries(name);
    expect(entries.filter((e) => e.startsWith("content-"))).toHaveLength(1);
  });
});

describe("content-keyed staging cache", () => {
  it("non-workspace dist-less plugin stages once, then cache-hits with no rebuild", async () => {
    const name = "stage-cache-hit-fixture";
    const installPath = await createSourceFixture(tmpDir, name, "cache-hit");
    const params = coldStageParams(installPath, name);

    const first = await stageColdPluginImportRoot(params);
    const entriesAfterFirst = await listStagingEntries(name);
    expect(
      entriesAfterFirst.filter((e) => e.startsWith("content-")),
    ).toHaveLength(1);
    expect(entriesAfterFirst.filter((e) => e.startsWith(".tmp-"))).toEqual([]);

    // Canary: present after the second call ⇔ the dir was reused, not rebuilt.
    const canaryPath = path.join(first, "canary-reuse-proof");
    await fsp.writeFile(canaryPath, "reused");

    const second = await stageColdPluginImportRoot(params);
    expect(second).toBe(first);
    await expect(fsp.readFile(canaryPath, "utf8")).resolves.toBe("reused");
    expect(await listStagingEntries(name)).toEqual(entriesAfterFirst);
  });

  it("cold import via importPluginModuleFromPath uses the cache dir and loads the module", async () => {
    const name = "stage-cache-import-fixture";
    const installPath = await createSourceFixture(tmpDir, name, "cache-import");

    const mod = (await importPluginModuleFromPath(installPath, name)) as {
      marker: string;
      moduleUrl: string;
    };

    expect(mod.marker).toBe("cache-import");
    const entries = await listStagingEntries(name);
    expect(entries.filter((e) => e.startsWith("content-"))).toHaveLength(1);
    expect(mod.moduleUrl).toContain(`content-`);
  });

  it("re-import after a cached cold import mints a FRESH generation dir (ESM bust preserved)", async () => {
    const name = "stage-cache-reimport-fixture";
    const installPath = await createSourceFixture(
      tmpDir,
      name,
      "cache-reimport",
    );

    const first = (await importPluginModuleFromPath(installPath, name)) as {
      moduleUrl: string;
    };
    const second = (await importPluginModuleFromPath(installPath, name)) as {
      marker: string;
      moduleUrl: string;
    };

    expect(second.marker).toBe("cache-reimport");
    // Different URL: the re-import must not be served from the cache dir the
    // cold import used, or the loader would return the stale module record.
    expect(second.moduleUrl).not.toBe(first.moduleUrl);
    const entries = await listStagingEntries(name);
    expect(entries.filter((e) => e.startsWith("content-"))).toHaveLength(1);
    expect(
      entries.filter((e) => !e.startsWith("content-") && !e.startsWith(".")),
    ).toHaveLength(1);
  });

  it("content change re-keys the cache (new content dir, old one left for GC)", async () => {
    const name = "stage-cache-rekey-fixture";
    const installPath = await createSourceFixture(tmpDir, name, "rekey-v1");
    const params = coldStageParams(installPath, name);

    const first = await stageColdPluginImportRoot(params);

    // Rewrite the module (bytes + mtime change → digest changes).
    await fsp.writeFile(
      path.join(installPath, "index.mjs"),
      "export const marker = 'rekey-v2';\nexport const moduleUrl = import.meta.url;\n",
    );
    // Force a distinct mtime even on filesystems with coarse timestamps.
    const futureTime = new Date(Date.now() + 5_000);
    await fsp.utimes(
      path.join(installPath, "index.mjs"),
      futureTime,
      futureTime,
    );

    const second = await stageColdPluginImportRoot(params);
    expect(second).not.toBe(first);
    await expect(
      fsp.readFile(path.join(second, "index.mjs"), "utf8"),
    ).resolves.toContain("rekey-v2");
    const entries = await listStagingEntries(name);
    expect(entries.filter((e) => e.startsWith("content-"))).toHaveLength(2);
  });

  it("corrupted/partial cache dir (missing completeness marker) is rebuilt", async () => {
    const name = "stage-cache-corrupt-fixture";
    const installPath = await createSourceFixture(tmpDir, name, "corrupt");
    const params = coldStageParams(installPath, name);

    const stagedRoot = await stageColdPluginImportRoot(params);
    const entries = await listStagingEntries(name);
    const contentDir = path.join(
      stagingDirFor(name),
      entries.find((e) => e.startsWith("content-")) as string,
    );

    // Corrupt: strip the marker and gut the staged tree, leaving junk behind.
    await fsp.rm(path.join(contentDir, ".eliza-staged-complete"));
    await fsp.rm(path.join(stagedRoot, "index.mjs"));
    await fsp.writeFile(path.join(contentDir, "junk"), "partial");

    const rebuilt = await stageColdPluginImportRoot(params);
    expect(rebuilt).toBe(stagedRoot);
    await expect(
      fsp.readFile(path.join(rebuilt, "index.mjs"), "utf8"),
    ).resolves.toContain("corrupt");
    await expect(
      fsp.stat(path.join(contentDir, ".eliza-staged-complete")),
    ).resolves.toBeTruthy();
    // The junk from the partial dir must not survive the rebuild.
    await expect(fsp.stat(path.join(contentDir, "junk"))).rejects.toThrow();
  });

  it("in-process concurrent staging of the same plugin is single-flight", async () => {
    const name = "stage-cache-concurrent-fixture";
    const installPath = await createSourceFixture(tmpDir, name, "concurrent");
    const params = coldStageParams(installPath, name);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => stageColdPluginImportRoot(params)),
    );

    expect(new Set(results).size).toBe(1);
    const entries = await listStagingEntries(name);
    expect(entries.filter((e) => e.startsWith("content-"))).toHaveLength(1);
    expect(entries.filter((e) => e.startsWith(".tmp-"))).toEqual([]);
  });

  it("two real processes racing to stage the same plugin converge on one dir", async () => {
    const name = "stage-cache-process-race-fixture";
    const installPath = await createSourceFixture(tmpDir, name, "race");
    const params = coldStageParams(installPath, name);

    // Each subprocess imports the real resolver (bun runs the TS source) and
    // stages the same params against the same ELIZA_STATE_DIR — a genuine
    // cross-process rename race on the same cache dir.
    const runnerPath = path.join(tmpDir, "race-runner.mjs");
    const resolverPath = path.join(import.meta.dirname, "plugin-resolver.ts");
    await fsp.writeFile(
      runnerPath,
      [
        `const { stageColdPluginImportRoot } = await import(${JSON.stringify(resolverPath)});`,
        `const result = await stageColdPluginImportRoot(${JSON.stringify(params)});`,
        `console.log(JSON.stringify({ result }));`,
      ].join("\n"),
    );

    const runOnce = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn("bun", [runnerPath], {
          env: { ...process.env, ELIZA_STATE_DIR: stateDir },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`runner exited ${code}: ${stderr}`));
            return;
          }
          const lastJsonLine = stdout
            .trim()
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .at(-1);
          if (!lastJsonLine) {
            reject(new Error(`no JSON output from runner: ${stdout}`));
            return;
          }
          resolve((JSON.parse(lastJsonLine) as { result: string }).result);
        });
      });

    const [a, b] = await Promise.all([runOnce(), runOnce()]);
    expect(a).toBe(b);
    const entries = await listStagingEntries(name);
    expect(entries.filter((e) => e.startsWith("content-"))).toHaveLength(1);
    expect(entries.filter((e) => e.startsWith(".tmp-"))).toEqual([]);
  }, 60_000);
});
