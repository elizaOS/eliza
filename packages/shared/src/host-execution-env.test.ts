/**
 * Exercises the explicit host executable authority with deterministic,
 * process-local boot captures; no runtime configuration or plugin mocks are
 * involved.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyHostExecutionBaseline,
  applyHostToolchainExecutionBaseline,
  captureHostExecutionBaseline,
  createHostExecutionBaseline,
  getHostExecutionBaseline,
  isHostExecutionBaselineMirrorKey,
  isHostExecutionToolchainEnvKey,
  resolveHostExecutable,
  validateHostExecutionDirectory,
  validateHostExecutionPath,
} from "./host-execution-env.ts";

const BASELINE_MIRROR_KEYS = [
  "ELIZA_HOST_EXECUTION_BASELINE_PATH",
  "ELIZA_HOST_EXECUTION_BASELINE_GOPATH",
  "ELIZA_HOST_EXECUTION_BASELINE_GOMODCACHE",
  "ELIZA_HOST_EXECUTION_BASELINE_GOCACHE",
] as const;

function withoutBaselineMirrors(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of BASELINE_MIRROR_KEYS) delete env[key];
  return env;
}

describe("host execution boot baseline", () => {
  it("captures before a later PATH write in a fresh process", () => {
    const bootPath = process.env.PATH;
    expect(bootPath).toBeTruthy();
    const fixture = fileURLToPath(
      new URL("./host-execution-env.fixture.ts", import.meta.url),
    );
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: bootPath,
      ELIZA_TEST_MUTATED_PATH: "/tmp/plugin-controlled-bin",
    };
    delete childEnv.GOPATH;
    delete childEnv.GOMODCACHE;
    delete childEnv.GOCACHE;
    const stdout = execFileSync(process.execPath, [fixture], {
      encoding: "utf8",
      env: childEnv,
    });
    expect(JSON.parse(stdout)).toMatchObject({
      path: bootPath,
      goPath: expect.stringMatching(/[/\\]go$/),
      goModCache: expect.stringMatching(/[/\\]go[/\\]pkg[/\\]mod$/),
      goCache: expect.stringMatching(/[/\\]go-build$/),
    });
  });

  it("keeps a fresh process capture after later environment mutation", () => {
    const bootPath =
      path.delimiter === ";" ? "C:\\Windows\\System32" : "/usr/bin:/bin";
    process.env.PATH = bootPath;
    captureHostExecutionBaseline();
    process.env.PATH = "/tmp/plugin-bin";
    const later = captureHostExecutionBaseline();
    expect(later.path).toBe(bootPath);
    expect(getHostExecutionBaseline().path).toBe(bootPath);
  });

  it("fails closed for absent, relative, empty-entry, and NUL paths", () => {
    expect(validateHostExecutionPath(undefined)).toBeUndefined();
    expect(validateHostExecutionPath("relative/bin")).toBeUndefined();
    expect(validateHostExecutionPath(`/bin${path.delimiter}`)).toBeUndefined();
    expect(validateHostExecutionPath("/bin\0/tmp")).toBeUndefined();
  });

  it("accepts the Windows Path casing but rejects ambiguous case variants", () => {
    expect(
      createHostExecutionBaseline({ Path: "C:\\Windows\\System32" }, "win32")
        .path,
    ).toBe("C:\\Windows\\System32");
    expect(
      createHostExecutionBaseline(
        { PATH: "C:\\Windows", Path: "C:\\Tools" },
        "win32",
      ).path,
    ).toBeUndefined();
  });

  it("handles Windows Go path lists, cache defaults, and duplicate casing", () => {
    expect(
      createHostExecutionBaseline(
        {
          Path: "C:\\Windows\\System32",
          GOPATH: "C:\\go-one;D:\\go-two",
          LOCALAPPDATA: "C:\\Users\\coder\\AppData\\Local",
        },
        "win32",
        "C:\\Users\\coder",
      ),
    ).toEqual({
      path: "C:\\Windows\\System32",
      goPath: "C:\\go-one;D:\\go-two",
      goModCache: "C:\\go-one\\pkg\\mod",
      goCache: "C:\\Users\\coder\\AppData\\Local\\go-build",
    });
    expect(
      createHostExecutionBaseline(
        {
          Path: "C:\\Windows\\System32",
          GOPATH: "C:\\caller-a",
          GoPath: "C:\\caller-b",
        },
        "win32",
        "C:\\Users\\coder",
      ).goPath,
    ).toBe("C:\\Users\\coder\\go");
  });

  it("derives complete Go defaults without HOME or Go variables", () => {
    expect(
      createHostExecutionBaseline(
        { PATH: "/usr/bin:/bin" },
        "darwin",
        "/Users/coder",
      ),
    ).toEqual({
      path: "/usr/bin:/bin",
      goPath: "/Users/coder/go",
      goModCache: "/Users/coder/go/pkg/mod",
      goCache: "/Users/coder/Library/Caches/go-build",
    });
  });

  it("preserves explicit absolute Go workspace and cache directories", () => {
    expect(
      createHostExecutionBaseline(
        {
          PATH: "/usr/bin:/bin",
          GOPATH: "/opt/go-work:/srv/go-work",
          GOMODCACHE: "/var/cache/go-mod",
          GOCACHE: "/var/cache/go-build",
        },
        "linux",
        "/home/coder",
      ),
    ).toEqual({
      path: "/usr/bin:/bin",
      goPath: "/opt/go-work:/srv/go-work",
      goModCache: "/var/cache/go-mod",
      goCache: "/var/cache/go-build",
    });
  });

  it("derives safe defaults instead of accepting relative Go paths", () => {
    expect(
      createHostExecutionBaseline(
        {
          PATH: "/usr/bin:/bin",
          GOPATH: "runtime/go",
          GOMODCACHE: "runtime/go-mod",
          GOCACHE: "off",
        },
        "linux",
        "/home/coder",
      ),
    ).toEqual({
      path: "/usr/bin:/bin",
      goPath: "/home/coder/go",
      goModCache: "/home/coder/go/pkg/mod",
      goCache: "/home/coder/.cache/go-build",
    });
  });

  it("rejects relative and NUL-bearing cache directories", () => {
    expect(validateHostExecutionDirectory("relative/cache")).toBeUndefined();
    expect(
      validateHostExecutionDirectory("/tmp/cache\0/escape"),
    ).toBeUndefined();
  });

  it("replaces mutable Go and PATH values with the captured baseline", () => {
    const baseline = getHostExecutionBaseline();
    const applied = applyHostExecutionBaseline({
      Path: "/tmp/late",
      gopath: "/tmp/runtime-go",
      GoModCache: "/tmp/runtime-mod",
      gocache: "/tmp/runtime-build",
      eliza_host_execution_baseline_path: "/tmp/runtime-path-mirror",
      eliza_host_execution_baseline_gopath: "/tmp/runtime-go-mirror",
      Eliza_Host_Execution_Baseline_Gomodcache: "/tmp/runtime-mod-mirror",
      ELIZA_HOST_EXECUTION_BASELINE_GOCACHE: "/tmp/runtime-cache-mirror",
      SAFE: "yes",
    });

    expect(applied).toMatchObject({
      PATH: baseline.path,
      GOPATH: baseline.goPath,
      GOMODCACHE: baseline.goModCache,
      GOCACHE: baseline.goCache,
      SAFE: "yes",
    });
    expect(applied.gopath).toBeUndefined();
    expect(applied.GoModCache).toBeUndefined();
    expect(applied.gocache).toBeUndefined();
    expect(applied.eliza_host_execution_baseline_path).toBeUndefined();
    expect(applied.ELIZA_HOST_EXECUTION_BASELINE_GOPATH).toBe(baseline.goPath);
  });

  it("replaces only toolchain authority when a validated session owns PATH", () => {
    const baseline = getHostExecutionBaseline();
    const applied = applyHostToolchainExecutionBaseline({
      PATH: "/trusted/session-wrapper:/usr/bin",
      GOPATH: "/caller/go",
      GOMODCACHE: "/caller/mod",
      GOCACHE: "/caller/build",
    });
    expect(applied).toMatchObject({
      PATH: "/trusted/session-wrapper:/usr/bin",
      GOPATH: baseline.goPath,
      GOMODCACHE: baseline.goModCache,
      GOCACHE: baseline.goCache,
    });
  });

  it("classifies Go variables and mirror aliases as host-only authority", () => {
    expect(isHostExecutionToolchainEnvKey("gopath")).toBe(true);
    expect(isHostExecutionToolchainEnvKey("GoModCache")).toBe(true);
    expect(isHostExecutionToolchainEnvKey("GOCACHE")).toBe(true);
    expect(
      isHostExecutionBaselineMirrorKey("eliza_host_execution_baseline_gocache"),
    ).toBe(true);
    expect(isHostExecutionToolchainEnvKey("GOFLAGS")).toBe(false);
  });

  it("rejects executable paths outside the captured PATH directories", () => {
    if (process.platform === "win32") return;
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "host-authority-"));
    const executable = path.join(tempDir, "outside-path");
    try {
      writeFileSync(executable, "#!/bin/sh\nexit 0\n");
      chmodSync(executable, 0o755);
      expect(resolveHostExecutable(executable)).toBeUndefined();
      expect(resolveHostExecutable("/bin/sh")).toBe("/bin/sh");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("host execution baseline env mirror", () => {
  it("capture publishes the authority for uncaptured module instances", () => {
    const fixture = fileURLToPath(
      new URL("./host-execution-env.bridge.fixture.ts", import.meta.url),
    );
    const stdout = execFileSync(process.execPath, [fixture], {
      encoding: "utf8",
      env: {
        ...withoutBaselineMirrors(),
        ELIZA_HOST_EXECUTION_BASELINE_PATH: "/usr/bin:/bin",
        ELIZA_HOST_EXECUTION_BASELINE_GOPATH: "/home/coder/go",
        ELIZA_HOST_EXECUTION_BASELINE_GOMODCACHE: "/home/coder/go/pkg/mod",
        ELIZA_HOST_EXECUTION_BASELINE_GOCACHE: "/home/coder/.cache/go-build",
      },
    });
    expect(JSON.parse(stdout)).toEqual({
      path: "/usr/bin:/bin",
      goPath: "/home/coder/go",
      goModCache: "/home/coder/go/pkg/mod",
      goCache: "/home/coder/.cache/go-build",
    });
  });

  it("rejects an invalid mirrored value instead of trusting it", () => {
    const fixture = fileURLToPath(
      new URL("./host-execution-env.bridge.fixture.ts", import.meta.url),
    );
    const stdout = execFileSync(process.execPath, [fixture], {
      encoding: "utf8",
      env: {
        ...withoutBaselineMirrors(),
        ELIZA_HOST_EXECUTION_BASELINE_PATH: "relative/entry:/bin",
      },
    });
    expect(JSON.parse(stdout)).toEqual({});
  });

  it("fills missing cross-version Go mirrors from the OS account home", () => {
    const fixture = fileURLToPath(
      new URL("./host-execution-env.bridge.fixture.ts", import.meta.url),
    );
    const stdout = execFileSync(process.execPath, [fixture], {
      encoding: "utf8",
      env: {
        ...withoutBaselineMirrors(),
        HOME: "/caller-controlled-home",
        ELIZA_HOST_EXECUTION_BASELINE_PATH: "/usr/bin:/bin",
      },
    });
    expect(JSON.parse(stdout)).toEqual(
      createHostExecutionBaseline(
        { PATH: "/usr/bin:/bin" },
        process.platform,
        os.userInfo().homedir,
      ),
    );
  });

  it("stays empty when no capture ran and no mirror is set", () => {
    const fixture = fileURLToPath(
      new URL("./host-execution-env.bridge.fixture.ts", import.meta.url),
    );
    const env = withoutBaselineMirrors();
    const stdout = execFileSync(process.execPath, [fixture], {
      encoding: "utf8",
      env,
    });
    expect(JSON.parse(stdout)).toEqual({});
  });
});
