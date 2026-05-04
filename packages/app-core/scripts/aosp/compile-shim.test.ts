import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLoaderWrapForAbi,
  buildSigsysShimForAbi,
  locateCompiledShim,
  parseArgs,
  SHIM_ABI_TARGETS,
} from "./compile-shim.mjs";

describe("compile-shim args", () => {
  it("defaults to x86_64 only and the seccomp-shim cache dir under ~/.cache/eliza-android-agent", () => {
    const args = parseArgs([]);
    // ARM64 has no legacy non-AT syscalls in the kernel ABI; it does not
    // need (and cannot use) the SIGSYS shim. The default ABI list is
    // x86_64-only by design.
    expect(args.abis).toEqual(["x86_64"]);
    expect(args.cacheDir).toBe(
      path.join(os.homedir(), ".cache", "eliza-android-agent", "seccomp-shim"),
    );
    expect(args.skipIfPresent).toBe(false);
  });

  it("--abi narrows to the supported set", () => {
    expect(parseArgs(["--abi", "x86_64"]).abis).toEqual(["x86_64"]);
  });

  it("--abi rejects arm64-v8a with a pointer to the rationale", () => {
    // ARM64 doesn't need the shim. The script must refuse rather than
    // silently produce a non-functional .so (sigsys-handler.c #errors
    // on non-x86_64 anyway, but we want the friendlier early-exit
    // diagnostic at the script layer).
    expect(() => parseArgs(["--abi", "arm64-v8a"])).toThrow(
      /--abi must be one of/,
    );
    expect(() => parseArgs(["--abi", "arm64-v8a"])).toThrow(
      /arm64-v8a doesn't need a SIGSYS shim/,
    );
  });

  it("--abi rejects unsupported triples", () => {
    expect(() => parseArgs(["--abi", "armeabi-v7a"])).toThrow(
      /--abi must be one of/,
    );
  });

  it("flags requiring values reject missing values", () => {
    expect(() => parseArgs(["--cache-dir"])).toThrow(
      /--cache-dir requires a value/,
    );
    expect(() => parseArgs(["--abi"])).toThrow(/--abi requires a value/);
  });

  it("rejects unknown flags rather than treating them as positional paths", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
  });

  it("accepts --skip-if-present idempotency switch", () => {
    expect(parseArgs(["--skip-if-present"]).skipIfPresent).toBe(true);
  });
});

describe("compile-shim ABI table", () => {
  it("only declares x86_64 — arm64 is intentionally excluded", () => {
    expect(SHIM_ABI_TARGETS).toHaveLength(1);
    const [target] = SHIM_ABI_TARGETS;
    expect(target?.androidAbi).toBe("x86_64");
    expect(target?.zigTarget).toBe("x86_64-linux-musl");
    expect(target?.realLoaderName).toBe("ld-musl-x86_64.so.1");
  });
});

describe("compile-shim build invocations", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "compile-shim-test-"));
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  function writeFakeShimSource(name: string): string {
    const source = path.join(scratchDir, name);
    fs.writeFileSync(source, "/* fake */\n", "utf8");
    return source;
  }

  it("invokes zig-cc with -shared/-fPIC for libsigsys-handler.so", () => {
    const shimSource = writeFakeShimSource("sigsys-handler.c");
    const captured: { command: string; args: string[] }[] = [];
    const fakeSpawn = (command: string, args: string[]) => {
      captured.push({ command, args });
      const outIdx = args.indexOf("-o");
      if (outIdx >= 0 && outIdx + 1 < args.length) {
        // biome-ignore lint/style/noNonNullAssertion: spawn-stub bookkeeping
        fs.writeFileSync(args[outIdx + 1]!, "ELF-stub", "utf8");
      }
    };
    const out = buildSigsysShimForAbi({
      cacheDir: scratchDir,
      abi: "x86_64",
      shimSourcePath: shimSource,
      log: () => {},
      spawn: fakeSpawn,
    });
    expect(out).toBe(path.join(scratchDir, "x86_64", "libsigsys-handler.so"));
    expect(captured.length).toBeGreaterThan(0);
    const compile = captured[0];
    expect(compile?.args).toContain("-shared");
    expect(compile?.args).toContain("-fPIC");
    expect(compile?.args).toContain("-O2");
    expect(compile?.args).toContain("-Wl,--disable-new-dtags");
    expect(compile?.args).toContain(shimSource);
    // Driver script path is the per-ABI zig-driver dir under cacheDir.
    expect(compile?.command).toBe(
      path.join(scratchDir, "zig-driver", "x86_64", "zig-cc"),
    );
  });

  it("invokes zig-cc with -static for the loader-wrap binary", () => {
    const wrapSource = writeFakeShimSource("loader-wrap.c");
    const captured: { command: string; args: string[] }[] = [];
    const fakeSpawn = (command: string, args: string[]) => {
      captured.push({ command, args });
      const outIdx = args.indexOf("-o");
      if (outIdx >= 0 && outIdx + 1 < args.length) {
        // biome-ignore lint/style/noNonNullAssertion: spawn-stub bookkeeping
        fs.writeFileSync(args[outIdx + 1]!, "ELF-stub", "utf8");
      }
    };
    const out = buildLoaderWrapForAbi({
      cacheDir: scratchDir,
      abi: "x86_64",
      loaderWrapSourcePath: wrapSource,
      log: () => {},
      spawn: fakeSpawn,
    });
    // Output filename matches the loader filename it replaces, so the
    // staging step in stage-android-agent.mjs can drop it in place.
    expect(out).toBe(path.join(scratchDir, "x86_64", "ld-musl-x86_64.so.1"));
    const compile = captured[0];
    expect(compile?.args).toContain("-static");
    // -static + -Wl,--disable-new-dtags ensure the wrapper has zero
    // NEEDED entries and no baked RUNPATH that would point at the
    // build host.
    expect(compile?.args).toContain("-Wl,--disable-new-dtags");
    expect(compile?.args).toContain(wrapSource);
    expect(compile?.command).toBe(
      path.join(scratchDir, "zig-driver", "x86_64", "zig-cc"),
    );
  });

  it("buildSigsysShimForAbi rejects unknown ABIs (arm64)", () => {
    const shimSource = writeFakeShimSource("sigsys-handler.c");
    expect(() =>
      buildSigsysShimForAbi({
        cacheDir: scratchDir,
        // @ts-expect-error -- intentionally invalid
        abi: "arm64-v8a",
        shimSourcePath: shimSource,
        log: () => {},
        spawn: () => {},
      }),
    ).toThrow(/Unknown ABI/);
  });

  it("buildSigsysShimForAbi fails loudly when source is missing", () => {
    expect(() =>
      buildSigsysShimForAbi({
        cacheDir: scratchDir,
        abi: "x86_64",
        shimSourcePath: path.join(scratchDir, "no-such-file.c"),
        log: () => {},
        spawn: () => {},
      }),
    ).toThrow(/sigsys-handler\.c not found/);
  });

  it("buildLoaderWrapForAbi fails loudly when source is missing", () => {
    expect(() =>
      buildLoaderWrapForAbi({
        cacheDir: scratchDir,
        abi: "x86_64",
        loaderWrapSourcePath: path.join(scratchDir, "no-such-file.c"),
        log: () => {},
        spawn: () => {},
      }),
    ).toThrow(/loader-wrap\.c not found/);
  });

  it("buildSigsysShimForAbi throws when compile produces an empty file", () => {
    const shimSource = writeFakeShimSource("sigsys-handler.c");
    const fakeSpawn = (_cmd: string, args: string[]) => {
      const outIdx = args.indexOf("-o");
      if (outIdx >= 0 && outIdx + 1 < args.length) {
        // biome-ignore lint/style/noNonNullAssertion: spawn-stub bookkeeping
        fs.writeFileSync(args[outIdx + 1]!, "", "utf8");
      }
    };
    expect(() =>
      buildSigsysShimForAbi({
        cacheDir: scratchDir,
        abi: "x86_64",
        shimSourcePath: shimSource,
        log: () => {},
        spawn: fakeSpawn,
      }),
    ).toThrow(/empty libsigsys-handler\.so/);
  });
});

describe("compile-shim locator", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "compile-shim-locator-test-"),
    );
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("returns null when the ABI is unsupported", () => {
    expect(locateCompiledShim({ cacheDir: scratchDir, abi: "arm64-v8a" })).toBe(
      null,
    );
  });

  it("returns null when shim or wrap is missing", () => {
    expect(
      locateCompiledShim({ cacheDir: scratchDir, abi: "x86_64" }),
    ).toBeNull();
    const abiDir = path.join(scratchDir, "x86_64");
    fs.mkdirSync(abiDir, { recursive: true });
    fs.writeFileSync(
      path.join(abiDir, "libsigsys-handler.so"),
      "ELF-stub",
      "utf8",
    );
    // Only the shim — wrap is missing.
    expect(
      locateCompiledShim({ cacheDir: scratchDir, abi: "x86_64" }),
    ).toBeNull();
  });

  it("returns absolute paths when both artifacts exist", () => {
    const abiDir = path.join(scratchDir, "x86_64");
    fs.mkdirSync(abiDir, { recursive: true });
    fs.writeFileSync(
      path.join(abiDir, "libsigsys-handler.so"),
      "ELF-stub",
      "utf8",
    );
    fs.writeFileSync(
      path.join(abiDir, "ld-musl-x86_64.so.1"),
      "ELF-stub",
      "utf8",
    );
    const located = locateCompiledShim({
      cacheDir: scratchDir,
      abi: "x86_64",
    });
    expect(located).not.toBeNull();
    expect(located?.shim).toBe(path.join(abiDir, "libsigsys-handler.so"));
    expect(located?.wrap).toBe(path.join(abiDir, "ld-musl-x86_64.so.1"));
    expect(located?.realLoaderName).toBe("ld-musl-x86_64.so.1");
  });
});
