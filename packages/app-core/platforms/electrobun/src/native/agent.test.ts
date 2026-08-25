/**
 * Exercises exported Electrobun agent native helpers against real filesystem
 * fixtures and isolated env objects. Drives the real module; does not mock it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDesktopDeferAppRoutesPolicy,
  applyPackagedStartupEmbeddingWarmupPolicy,
  buildChildNodePaths,
  configureDesktopLocalApiAuth,
  ensureDesktopApiToken,
  getHealthPollTimeoutMs,
  getRuntimeDistFallbackCandidates,
  inspectExistingElizaInstall,
  isPackagedDesktopRuntime,
  migrateDesktopStateDirFromPath,
  prependDesktopChildPathDirectory,
  redactSensitiveDiagnostics,
  resolveBunExecutablePath,
  resolveConfigDir,
  resolveRuntimeDistPath,
  resolveRuntimeEntryPath,
} from "./agent";

const tmpDirs: string[] = [];

function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("getHealthPollTimeoutMs", () => {
  it("uses the explicit positive timeout from env after trim", () => {
    expect(
      getHealthPollTimeoutMs(
        { ELIZA_AGENT_HEALTH_TIMEOUT_MS: "  2500  " },
        "darwin",
      ),
    ).toBe(2500);
  });

  it("parses with parseInt, so a fractional string keeps the integer prefix", () => {
    expect(
      getHealthPollTimeoutMs(
        { ELIZA_AGENT_HEALTH_TIMEOUT_MS: "90.9" },
        "linux",
      ),
    ).toBe(90);
  });

  it("falls back to the platform default when the override is missing, empty, zero, negative, or non-numeric", () => {
    expect(getHealthPollTimeoutMs({}, "linux")).toBe(120_000);
    expect(getHealthPollTimeoutMs({}, "darwin")).toBe(120_000);
    expect(getHealthPollTimeoutMs({}, "win32")).toBe(240_000);
    expect(
      getHealthPollTimeoutMs({ ELIZA_AGENT_HEALTH_TIMEOUT_MS: "" }, "win32"),
    ).toBe(240_000);
    expect(
      getHealthPollTimeoutMs({ ELIZA_AGENT_HEALTH_TIMEOUT_MS: "  " }, "linux"),
    ).toBe(120_000);
    expect(
      getHealthPollTimeoutMs({ ELIZA_AGENT_HEALTH_TIMEOUT_MS: "0" }, "linux"),
    ).toBe(120_000);
    expect(
      getHealthPollTimeoutMs({ ELIZA_AGENT_HEALTH_TIMEOUT_MS: "-1" }, "win32"),
    ).toBe(240_000);
    expect(
      getHealthPollTimeoutMs({ ELIZA_AGENT_HEALTH_TIMEOUT_MS: "abc" }, "linux"),
    ).toBe(120_000);
  });
});

describe("applyPackagedStartupEmbeddingWarmupPolicy", () => {
  it("does not mutate env when the runtime is not packaged", () => {
    const env: Record<string, string> = {};
    applyPackagedStartupEmbeddingWarmupPolicy(env, false);
    expect(env).toEqual({});
  });

  it("treats true/yes as warmup opt-in and leaves on as a skip", () => {
    const opted: Record<string, string> = {
      ELIZA_ENABLE_STARTUP_LOCAL_EMBEDDING_WARMUP: "YES",
    };
    applyPackagedStartupEmbeddingWarmupPolicy(opted, true);
    expect(opted.ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP).toBeUndefined();
    expect(opted.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP).toBe("0");

    const ignored: Record<string, string> = {
      ELIZA_ENABLE_STARTUP_LOCAL_EMBEDDING_WARMUP: "on",
    };
    applyPackagedStartupEmbeddingWarmupPolicy(ignored, true);
    expect(ignored.ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP).toBe("1");
  });
});

describe("applyDesktopDeferAppRoutesPolicy", () => {
  it("overwrites a whitespace-only ELIZA_DEFER_APP_ROUTES with the desktop default", () => {
    const env: Record<string, string> = { ELIZA_DEFER_APP_ROUTES: "   " };
    applyDesktopDeferAppRoutesPolicy(env);
    expect(env.ELIZA_DEFER_APP_ROUTES).toBe("1");
  });
});

describe("prependDesktopChildPathDirectory", () => {
  it("uses the Path key when PATH is absent and prepends in front of existing entries", () => {
    const env: Record<string, string | undefined> = {
      Path: `/usr/bin${path.delimiter}/bin`,
    };
    expect(prependDesktopChildPathDirectory(env, "/opt/bun/bin")).toBe(true);
    expect(env.Path).toBe(
      `/opt/bun/bin${path.delimiter}/usr/bin${path.delimiter}/bin`,
    );
    expect(env.PATH).toBeUndefined();
  });

  it("does not treat a path prefix as already present", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/opt/bun/bin",
    };
    expect(prependDesktopChildPathDirectory(env, "/opt/bun")).toBe(true);
    expect(env.PATH).toBe(`/opt/bun${path.delimiter}/opt/bun/bin`);
  });
});

describe("resolveConfigDir", () => {
  it("uses ~/.config/{configDirName} on non-Windows platforms", () => {
    expect(
      resolveConfigDir({ platform: "darwin", homedir: "/Users/example" }),
    ).toBe("/Users/example/.config/elizaOS");
    expect(
      resolveConfigDir({ platform: "linux", homedir: "/home/example" }),
    ).toBe("/home/example/.config/elizaOS");
  });

  it("uses APPDATA or the Windows roaming fallback on win32", () => {
    expect(
      resolveConfigDir({
        platform: "win32",
        appdata: "C:\\Users\\X\\AppData\\Roaming",
        homedir: "C:\\Users\\X",
      }),
    ).toBe(path.join("C:\\Users\\X\\AppData\\Roaming", "elizaOS"));
    expect(
      resolveConfigDir({
        platform: "win32",
        homedir: "/Users/example",
      }),
    ).toBe("/Users/example/AppData/Roaming/elizaOS");
  });
});

describe("inspectExistingElizaInstall", () => {
  it("reports no detection when every candidate is empty", () => {
    const homedir = makeTmp("eliza-install-empty-");
    const info = inspectExistingElizaInstall({
      env: { ELIZA_NAMESPACE: "example" } as NodeJS.ProcessEnv,
      homedir,
    });
    expect(info.detected).toBe(false);
    expect(info.configExists).toBe(false);
    expect(info.hasStateEntries).toBe(false);
    expect(info.source).toBe("default-state-dir");
    expect(info.stateDir).toBe(
      path.join(homedir, ".local", "state", "example"),
    );
    expect(info.configPath).toBe(path.join(info.stateDir, "eliza.json"));
  });

  it("detects ELIZA_CONFIG_PATH before other candidates", () => {
    const root = makeTmp("eliza-install-config-");
    const stateDir = path.join(root, "from-config");
    const configPath = path.join(stateDir, "eliza.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, "{}");

    const info = inspectExistingElizaInstall({
      env: {
        ELIZA_NAMESPACE: "example",
        ELIZA_CONFIG_PATH: configPath,
      } as NodeJS.ProcessEnv,
      homedir: root,
    });
    expect(info).toMatchObject({
      detected: true,
      source: "config-path-env",
      stateDir,
      configPath,
      configExists: true,
      stateDirExists: true,
      hasStateEntries: true,
    });
  });

  it("detects a state-dir override that has real entries, ignoring .DS_Store", () => {
    const root = makeTmp("eliza-install-state-");
    const empty = path.join(root, "empty-state");
    const filled = path.join(root, "filled-state");
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(empty, ".DS_Store"), "");
    fs.mkdirSync(filled, { recursive: true });
    fs.writeFileSync(path.join(filled, "memory.db"), "x");

    expect(
      inspectExistingElizaInstall({
        env: {
          ELIZA_NAMESPACE: "example",
          ELIZA_STATE_DIR: empty,
        } as NodeJS.ProcessEnv,
        homedir: root,
      }).detected,
    ).toBe(false);

    const info = inspectExistingElizaInstall({
      env: {
        ELIZA_NAMESPACE: "example",
        ELIZA_STATE_DIR: filled,
      } as NodeJS.ProcessEnv,
      homedir: root,
    });
    expect(info).toMatchObject({
      detected: true,
      source: "state-dir-env",
      stateDir: filled,
      configExists: false,
      hasStateEntries: true,
    });
  });

  it("detects the legacy ~/.{namespace} dir when the default XDG state dir is empty", () => {
    const homedir = makeTmp("eliza-install-legacy-");
    const legacy = path.join(homedir, ".example");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "eliza.json"), "{}");

    const info = inspectExistingElizaInstall({
      env: { ELIZA_NAMESPACE: "example" } as NodeJS.ProcessEnv,
      homedir,
    });
    expect(info).toMatchObject({
      detected: true,
      source: "legacy-dot-state-dir",
      stateDir: legacy,
      configExists: true,
    });
  });

  it("prefers the default XDG state dir over a coexisting legacy dir", () => {
    const homedir = makeTmp("eliza-install-prefers-default-");
    const def = path.join(homedir, ".local", "state", "example");
    const legacy = path.join(homedir, ".example");
    fs.mkdirSync(def, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(def, "eliza.json"), "{}");
    fs.writeFileSync(path.join(legacy, "eliza.json"), "{}");

    const info = inspectExistingElizaInstall({
      env: { ELIZA_NAMESPACE: "example" } as NodeJS.ProcessEnv,
      homedir,
    });
    expect(info.source).toBe("default-state-dir");
    expect(info.stateDir).toBe(def);
  });

  it("dedupes a config-path candidate that already matches the state-dir candidate", () => {
    const root = makeTmp("eliza-install-dedupe-");
    const stateDir = path.join(root, "shared");
    const configPath = path.join(stateDir, "eliza.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, "{}");

    const info = inspectExistingElizaInstall({
      env: {
        ELIZA_NAMESPACE: "example",
        ELIZA_STATE_DIR: stateDir,
        ELIZA_CONFIG_PATH: configPath,
      } as NodeJS.ProcessEnv,
      homedir: root,
    });
    expect(info.source).toBe("config-path-env");
    expect(info.stateDir).toBe(stateDir);
  });

  it("does not treat a file used as ELIZA_STATE_DIR as a populated install", () => {
    const root = makeTmp("eliza-install-file-state-");
    const asFile = path.join(root, "not-a-dir");
    fs.writeFileSync(asFile, "x");

    const info = inspectExistingElizaInstall({
      env: {
        ELIZA_NAMESPACE: "example",
        ELIZA_STATE_DIR: asFile,
      } as NodeJS.ProcessEnv,
      homedir: root,
    });
    expect(info.detected).toBe(false);
    expect(info.hasStateEntries).toBe(false);
    // Undetected fallback still reports the first candidate's source (the
    // file-valued ELIZA_STATE_DIR), not the later default-state-dir entry.
    expect(info.source).toBe("state-dir-env");
    expect(info.stateDir).toBe(asFile);
  });
});

describe("migrateDesktopStateDirFromPath", () => {
  it("skips when source and target resolve to the same path", () => {
    const dir = makeTmp("eliza-migrate-same-");
    const result = migrateDesktopStateDirFromPath(dir, {
      env: { ELIZA_STATE_DIR: dir } as NodeJS.ProcessEnv,
    });
    expect(result).toMatchObject({
      ok: true,
      migrated: false,
      skippedReason: "same-path",
      fromPath: dir,
      toPath: dir,
    });
  });

  it("skips a source that exists but is not a directory", () => {
    const root = makeTmp("eliza-migrate-file-");
    const source = path.join(root, "file");
    const target = path.join(root, "target");
    fs.writeFileSync(source, "x");

    const result = migrateDesktopStateDirFromPath(source, {
      env: { ELIZA_STATE_DIR: target } as NodeJS.ProcessEnv,
    });
    expect(result).toMatchObject({
      ok: true,
      migrated: false,
      skippedReason: "source-not-directory",
      fromPath: source,
      toPath: target,
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it("copies a real directory tree into the target state dir", () => {
    const root = makeTmp("eliza-migrate-copy-");
    const source = path.join(root, "from");
    const target = path.join(root, "to");
    fs.mkdirSync(path.join(source, "nested"), { recursive: true });
    fs.writeFileSync(path.join(source, "nested", "keep.txt"), "payload");

    const result = migrateDesktopStateDirFromPath(source, {
      env: { ELIZA_STATE_DIR: target } as NodeJS.ProcessEnv,
    });
    expect(result).toMatchObject({
      ok: true,
      migrated: true,
      fromPath: source,
      toPath: target,
    });
    expect(result.skippedReason).toBeUndefined();
    expect(
      fs.readFileSync(path.join(target, "nested", "keep.txt"), "utf8"),
    ).toBe("payload");
  });
});

describe("ensureDesktopApiToken and configureDesktopLocalApiAuth", () => {
  it("reuses an existing token and writes it back onto the env object", () => {
    const env: NodeJS.ProcessEnv = { ELIZA_API_TOKEN: "existing-token" };
    expect(ensureDesktopApiToken(env)).toBe("existing-token");
    expect(env.ELIZA_API_TOKEN).toBe("existing-token");
  });

  it("generates a 32-char hex token when auto-token is allowed", () => {
    const env: NodeJS.ProcessEnv = {};
    const token = ensureDesktopApiToken(env);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(env.ELIZA_API_TOKEN).toBe(token);
  });

  it("returns an empty string when auto-token generation is disabled", () => {
    const env: NodeJS.ProcessEnv = { ELIZA_DISABLE_AUTO_API_TOKEN: "1" };
    expect(ensureDesktopApiToken(env)).toBe("");
    expect(env.ELIZA_API_TOKEN).toBeUndefined();
  });

  it("enables pairing-disabled while returning the resolved token", () => {
    const env: NodeJS.ProcessEnv = { ELIZA_API_TOKEN: "paired" };
    expect(configureDesktopLocalApiAuth(env)).toBe("paired");
    expect(env.ELIZA_PAIRING_DISABLED).toBe("1");
  });
});

describe("redactSensitiveDiagnostics", () => {
  it("redacts bearer credentials and secret-like assignments", () => {
    expect(
      redactSensitiveDiagnostics("Authorization: Bearer abc.def-ghi"),
    ).toBe("Authorization: Bearer [REDACTED]");
    expect(redactSensitiveDiagnostics("authorization = bearer tok_123")).toBe(
      "authorization = bearer [REDACTED]",
    );
    expect(redactSensitiveDiagnostics("X-Api-Key: super-secret")).toBe(
      "X-Api-Key: [REDACTED]",
    );
    expect(redactSensitiveDiagnostics("api_key=xyz password=hunter2")).toBe(
      "api_key=[REDACTED] password=[REDACTED]",
    );
  });

  it("leaves unrelated log text unchanged", () => {
    expect(redactSensitiveDiagnostics("listening on port 3000")).toBe(
      "listening on port 3000",
    );
  });
});

describe("getRuntimeDistFallbackCandidates", () => {
  it("returns unique candidates derived from the exec and module dirs", () => {
    const execPath = "/Applications/elizaOS.app/Contents/MacOS/eliza";
    const moduleDir = "/Applications/elizaOS.app/Contents/Resources/app/src";
    const candidates = getRuntimeDistFallbackCandidates(moduleDir, execPath);
    expect(candidates.length).toBeGreaterThan(0);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates).toContain(
      "/Applications/elizaOS.app/Contents/Resources/app/eliza-dist",
    );
    expect(candidates).toContain(
      "/Applications/elizaOS.app/Contents/MacOS/resources/app/eliza-dist",
    );
  });

  it("falls back to moduleDir when execPath is empty", () => {
    const moduleDir = "/opt/eliza/src";
    const candidates = getRuntimeDistFallbackCandidates(moduleDir, "");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.length > 0)).toBe(true);
  });
});

describe("isPackagedDesktopRuntime", () => {
  const previousDist = process.env.ELIZA_DIST_PATH;

  afterEach(() => {
    if (previousDist === undefined) {
      delete process.env.ELIZA_DIST_PATH;
    } else {
      process.env.ELIZA_DIST_PATH = previousDist;
    }
  });

  it("is unpackaged when the module lives under /src/ and the exec is a normal bun", () => {
    delete process.env.ELIZA_DIST_PATH;
    expect(
      isPackagedDesktopRuntime("/repo/packages/app/src/native", "/usr/bin/bun"),
    ).toBe(false);
  });

  it("is packaged when the module dir has no /src/ segment", () => {
    delete process.env.ELIZA_DIST_PATH;
    expect(
      isPackagedDesktopRuntime(
        "/Applications/elizaOS.app/Contents/Resources/app",
        "/usr/bin/bun",
      ),
    ).toBe(true);
  });

  it("is packaged when the exec path looks like a desktop launcher", () => {
    delete process.env.ELIZA_DIST_PATH;
    expect(
      isPackagedDesktopRuntime(
        "/repo/src/native",
        "/Applications/elizaOS.app/Contents/MacOS/eliza",
      ),
    ).toBe(true);
    expect(
      isPackagedDesktopRuntime(
        "/repo/src/native",
        "/tmp/self-extraction/payload",
      ),
    ).toBe(true);
    expect(
      isPackagedDesktopRuntime("/repo/src/native", "/opt/app/launcher"),
    ).toBe(true);
    expect(
      isPackagedDesktopRuntime("/repo/src/native", "/opt/app/launcher.exe"),
    ).toBe(true);
  });

  it("is unpackaged when ELIZA_DIST_PATH is set and the exec is not a packaged launcher", () => {
    process.env.ELIZA_DIST_PATH = "/tmp/eliza-dist";
    expect(
      isPackagedDesktopRuntime("/opt/app/Resources/app", "/usr/bin/bun"),
    ).toBe(false);
  });
});

describe("resolveBunExecutablePath", () => {
  it("returns an existing bun next to execPath", () => {
    const root = makeTmp("eliza-bun-exec-");
    const bunPath = path.join(root, "bun");
    fs.writeFileSync(bunPath, "");
    expect(
      resolveBunExecutablePath({
        execPath: bunPath,
        moduleDir: path.join(root, "src", "native"),
        platform: "darwin",
      }),
    ).toBe(bunPath);
  });

  it("selects bun.exe on win32 unless the exec is a macOS bundle", () => {
    const root = makeTmp("eliza-bun-win-");
    const exe = path.join(root, "bun.exe");
    fs.writeFileSync(exe, "");
    expect(
      resolveBunExecutablePath({
        execPath: exe,
        moduleDir: path.join(root, "src", "native"),
        platform: "win32",
      }),
    ).toBe(exe);

    const macRoot = makeTmp("eliza-bun-macbundle-");
    const execDir = path.join(macRoot, "elizaOS.app", "Contents", "MacOS");
    fs.mkdirSync(execDir, { recursive: true });
    const bunPath = path.join(execDir, "bun");
    fs.writeFileSync(bunPath, "");
    expect(
      resolveBunExecutablePath({
        execPath: path.join(execDir, "eliza"),
        moduleDir: path.join(macRoot, "src"),
        platform: "win32",
      }),
    ).toBe(bunPath);
  });

  it("falls back to a sibling bun path for a packaged launcher that is not named bun", () => {
    expect(
      resolveBunExecutablePath({
        execPath: "/nonexistent/app/launcher",
        moduleDir: "/nonexistent/app",
        platform: "darwin",
      }),
    ).toBe("/nonexistent/app/bun");
  });
});

describe("resolveRuntimeDistPath", () => {
  const previousDist = process.env.ELIZA_DIST_PATH;

  afterEach(() => {
    if (previousDist === undefined) {
      delete process.env.ELIZA_DIST_PATH;
    } else {
      process.env.ELIZA_DIST_PATH = previousDist;
    }
  });

  it("honors an existing ELIZA_DIST_PATH on an unpackaged module", () => {
    delete process.env.ELIZA_DIST_PATH;
    const root = makeTmp("eliza-dist-env-");
    const dist = path.join(root, "custom-dist");
    fs.mkdirSync(dist, { recursive: true });
    expect(
      resolveRuntimeDistPath({
        env: { ELIZA_DIST_PATH: dist } as NodeJS.ProcessEnv,
        moduleDir: path.join(root, "src", "native"),
        execPath: path.join(root, "bin", "bun"),
      }),
    ).toBe(dist);
  });

  it("walks up from the module dir to a dist/entry.js layout", () => {
    delete process.env.ELIZA_DIST_PATH;
    const root = makeTmp("eliza-dist-walk-");
    const moduleDir = path.join(root, "src", "native");
    fs.mkdirSync(moduleDir, { recursive: true });
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "entry.js"), "");
    expect(
      resolveRuntimeDistPath({
        env: {} as NodeJS.ProcessEnv,
        moduleDir,
        execPath: path.join(root, "bin", "bun"),
      }),
    ).toBe(dist);
  });

  it("returns the first existing packaged fallback candidate", () => {
    delete process.env.ELIZA_DIST_PATH;
    const root = makeTmp("eliza-dist-packaged-");
    const execPath = path.join(root, "Contents", "MacOS", "eliza");
    fs.mkdirSync(path.dirname(execPath), { recursive: true });
    const dist = path.join(root, "Contents", "Resources", "app", "eliza-dist");
    fs.mkdirSync(dist, { recursive: true });
    expect(
      resolveRuntimeDistPath({
        env: {} as NodeJS.ProcessEnv,
        moduleDir: path.join(root, "Contents", "Resources", "app"),
        execPath,
      }),
    ).toBe(dist);
  });
});

describe("buildChildNodePaths", () => {
  it("returns an empty list when no node_modules exist", () => {
    const root = makeTmp("eliza-nodepath-empty-");
    expect(buildChildNodePaths(root)).toEqual([]);
    expect(buildChildNodePaths(root, { packagedRuntime: true })).toEqual([]);
  });

  it("includes dist node_modules and stops walking after the first parent in unpackaged mode", () => {
    const root = makeTmp("eliza-nodepath-walk-");
    const dist = path.join(root, "pkg", "dist");
    const distModules = path.join(dist, "node_modules");
    const parentModules = path.join(root, "pkg", "node_modules");
    const grandparentModules = path.join(root, "node_modules");
    fs.mkdirSync(distModules, { recursive: true });
    fs.mkdirSync(parentModules, { recursive: true });
    fs.mkdirSync(grandparentModules, { recursive: true });

    expect(buildChildNodePaths(dist, { packagedRuntime: true })).toEqual([
      distModules,
    ]);
    expect(buildChildNodePaths(dist)).toEqual([distModules, parentModules]);
  });

  it("walks to a parent node_modules when the dist itself has none", () => {
    const root = makeTmp("eliza-nodepath-parent-");
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const parentModules = path.join(root, "node_modules");
    fs.mkdirSync(parentModules, { recursive: true });
    expect(buildChildNodePaths(dist)).toEqual([parentModules]);
  });
});

describe("resolveRuntimeEntryPath", () => {
  it("returns null when neither layout exists", () => {
    const root = makeTmp("eliza-entry-missing-");
    expect(resolveRuntimeEntryPath(root)).toBeNull();
  });
});
