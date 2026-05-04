import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ABI_TARGETS,
  buildShimForAbi,
  compareSemver,
  ensureZigDrivers,
  LLAMA_CPP_COMMIT,
  LLAMA_CPP_TAG,
  MIN_ZIG_VERSION,
  parseArgs,
  patchLlamaCppSourceForMusl,
  probeZig,
} from "./compile-libllama.mjs";

describe("compile-libllama args", () => {
  it("defaults to both ABIs and the cache dir under ~/.cache/eliza-android-agent", () => {
    const args = parseArgs([]);
    expect(args.abis).toEqual(["arm64-v8a", "x86_64"]);
    expect(args.cacheDir).toBe(
      path.join(
        os.homedir(),
        ".cache",
        "eliza-android-agent",
        `llama-cpp-${LLAMA_CPP_TAG}`,
      ),
    );
    expect(args.skipIfPresent).toBe(false);
    expect(typeof args.androidAssetsDir).toBe("string");
    expect(args.androidAssetsDir).toContain(
      path.join(
        "apps",
        "app",
        "android",
        "app",
        "src",
        "main",
        "assets",
        "agent",
      ),
    );
  });

  it("--abi narrows to one ABI", () => {
    expect(parseArgs(["--abi", "arm64-v8a"]).abis).toEqual(["arm64-v8a"]);
    expect(parseArgs(["--abi", "x86_64"]).abis).toEqual(["x86_64"]);
  });

  it("--abi rejects unsupported values", () => {
    expect(() => parseArgs(["--abi", "armeabi-v7a"])).toThrow(
      /--abi must be one of/,
    );
  });

  it("--jobs / -j must be a positive integer", () => {
    expect(parseArgs(["--jobs", "4"]).jobs).toBe(4);
    expect(parseArgs(["-j", "8"]).jobs).toBe(8);
    expect(() => parseArgs(["--jobs", "0"])).toThrow(
      /--jobs must be a positive integer/,
    );
    expect(() => parseArgs(["--jobs", "-2"])).toThrow(
      /--jobs must be a positive integer/,
    );
  });

  it("flags requiring values reject missing values", () => {
    expect(() => parseArgs(["--assets-dir"])).toThrow(
      /--assets-dir requires a value/,
    );
    expect(() => parseArgs(["--cache-dir"])).toThrow(
      /--cache-dir requires a value/,
    );
    expect(() => parseArgs(["--abi"])).toThrow(/--abi requires a value/);
    expect(() => parseArgs(["--jobs"])).toThrow(/--jobs requires a value/);
  });

  it("rejects unknown flags rather than treating them as positional paths", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
  });

  it("accepts --skip-if-present idempotency switch", () => {
    expect(parseArgs(["--skip-if-present"]).skipIfPresent).toBe(true);
  });
});

describe("compile-libllama version comparison", () => {
  it("compareSemver handles dev/release/v-prefixed inputs deterministically", () => {
    expect(compareSemver("0.13.0", "0.13.0")).toBe(0);
    expect(compareSemver("0.12.0", "0.13.0")).toBeLessThan(0);
    expect(compareSemver("0.14.0", "0.13.0")).toBeGreaterThan(0);
    expect(compareSemver("v0.13.0", "0.13.0")).toBe(0);
    // dev-build suffix is stripped before comparison
    expect(compareSemver("0.13.0-dev.1234+abcdef", "0.13.0")).toBe(0);
    expect(
      compareSemver("0.13.0-dev.1234+abcdef", "0.13.0-dev.5678+ffff"),
    ).toBe(0);
    expect(compareSemver("1.0.0", "0.99.0")).toBeGreaterThan(0);
  });
});

describe("compile-libllama toolchain probe", () => {
  it("throws an actionable install hint when zig is missing", () => {
    const fakeSpawn = () => ({
      error: new Error("ENOENT"),
      status: null,
      stdout: "",
      stderr: "",
    });
    expect(() => probeZig({ spawn: fakeSpawn, platform: "linux" })).toThrow(
      /zig is required/,
    );
    expect(() => probeZig({ spawn: fakeSpawn, platform: "linux" })).toThrow(
      /snap install zig/,
    );
    expect(() => probeZig({ spawn: fakeSpawn, platform: "darwin" })).toThrow(
      /brew install zig/,
    );
  });

  it("rejects zig versions below the required minimum", () => {
    const fakeSpawn = () => ({
      error: null,
      status: 0,
      stdout: "0.12.1\n",
      stderr: "",
    });
    expect(() => probeZig({ spawn: fakeSpawn, platform: "linux" })).toThrow(
      new RegExp(`zig 0\\.12\\.1 is too old.*${MIN_ZIG_VERSION}`),
    );
  });

  it("returns the version string on a passing probe", () => {
    const fakeSpawn = () => ({
      error: null,
      status: 0,
      stdout: "0.13.0\n",
      stderr: "",
    });
    expect(probeZig({ spawn: fakeSpawn, platform: "linux" })).toBe("0.13.0");
  });
});

describe("compile-libllama zig driver scripts", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "compile-libllama-test-"),
    );
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("writes per-ABI zig-cc / zig-cxx scripts that wrap zig with --target", () => {
    const { ccPath, cxxPath } = ensureZigDrivers({
      cacheDir: scratchDir,
      abi: "arm64-v8a",
      zigBin: "/opt/zig/zig",
    });
    expect(ccPath).toBe(
      path.join(scratchDir, "zig-driver", "arm64-v8a", "zig-cc"),
    );
    expect(cxxPath).toBe(
      path.join(scratchDir, "zig-driver", "arm64-v8a", "zig-cxx"),
    );
    const ccBody = fs.readFileSync(ccPath, "utf8");
    const cxxBody = fs.readFileSync(cxxPath, "utf8");
    expect(ccBody).toContain(
      'exec "/opt/zig/zig" cc --target=aarch64-linux-musl',
    );
    expect(cxxBody).toContain(
      'exec "/opt/zig/zig" c++ --target=aarch64-linux-musl',
    );
    // Driver scripts must be executable so cmake can invoke them.
    expect(fs.statSync(ccPath).mode & 0o111).not.toBe(0);
    expect(fs.statSync(cxxPath).mode & 0o111).not.toBe(0);
  });

  it("emits a different triple per ABI", () => {
    const arm = ensureZigDrivers({
      cacheDir: scratchDir,
      abi: "arm64-v8a",
      zigBin: "zig",
    });
    const x86 = ensureZigDrivers({
      cacheDir: scratchDir,
      abi: "x86_64",
      zigBin: "zig",
    });
    const armCc = fs.readFileSync(arm.ccPath, "utf8");
    const x86Cc = fs.readFileSync(x86.ccPath, "utf8");
    expect(armCc).toContain("--target=aarch64-linux-musl");
    expect(x86Cc).toContain("--target=x86_64-linux-musl");
  });

  it("rejects unknown ABIs", () => {
    expect(() =>
      ensureZigDrivers({
        cacheDir: scratchDir,
        // @ts-expect-error -- intentional bad input
        abi: "armeabi-v7a",
        zigBin: "zig",
      }),
    ).toThrow(/Unknown ABI/);
  });
});

describe("compile-libllama musl source patch", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "compile-libllama-test-"),
    );
    fs.mkdirSync(path.join(scratchDir, "ggml", "src"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  const PRE_IMAGE_BLOCK =
    "#if defined(__linux__)\n" +
    "#include <execinfo.h>\n" +
    "static void ggml_print_backtrace_symbols(void) {\n" +
    "    void * trace[100];\n" +
    "    int nptrs = backtrace(trace, sizeof(trace)/sizeof(trace[0]));\n" +
    "    backtrace_symbols_fd(trace, nptrs, STDERR_FILENO);\n" +
    "}\n" +
    "#else\n" +
    "static void ggml_print_backtrace_symbols(void) {\n" +
    "    // platform not supported\n" +
    "}\n" +
    "#endif\n";

  it("rewrites the __linux__ guard to require __GLIBC__ on first run", () => {
    const file = path.join(scratchDir, "ggml", "src", "ggml.c");
    fs.writeFileSync(
      file,
      `// preamble\n${PRE_IMAGE_BLOCK}// trailing code\n`,
      "utf8",
    );
    patchLlamaCppSourceForMusl({ srcDir: scratchDir, log: () => {} });
    const after = fs.readFileSync(file, "utf8");
    expect(after).toContain("#if defined(__linux__) && defined(__GLIBC__)");
    expect(after).not.toContain(
      "#if defined(__linux__)\n#include <execinfo.h>",
    );
    expect(
      fs.existsSync(
        path.join(scratchDir, `.musl-execinfo-patched.${LLAMA_CPP_COMMIT}`),
      ),
    ).toBe(true);
  });

  it("is idempotent — second invocation is a no-op", () => {
    const file = path.join(scratchDir, "ggml", "src", "ggml.c");
    fs.writeFileSync(file, PRE_IMAGE_BLOCK, "utf8");
    patchLlamaCppSourceForMusl({ srcDir: scratchDir, log: () => {} });
    const firstPass = fs.readFileSync(file, "utf8");
    patchLlamaCppSourceForMusl({ srcDir: scratchDir, log: () => {} });
    const secondPass = fs.readFileSync(file, "utf8");
    expect(secondPass).toBe(firstPass);
  });

  it("no-ops when source already gates execinfo on __GLIBC__ (b4500+ pin path)", () => {
    const file = path.join(scratchDir, "ggml", "src", "ggml.c");
    const upstreamFixed =
      "// preamble\n" +
      "#elif defined(__linux__) && defined(__GLIBC__)\n" +
      "#include <execinfo.h>\n" +
      "static void ggml_print_backtrace_symbols(void) {\n" +
      "    backtrace_symbols_fd(NULL, 0, 0);\n" +
      "}\n" +
      "// trailing code\n";
    fs.writeFileSync(file, upstreamFixed, "utf8");
    patchLlamaCppSourceForMusl({ srcDir: scratchDir, log: () => {} });
    expect(fs.readFileSync(file, "utf8")).toBe(upstreamFixed);
    expect(
      fs.existsSync(
        path.join(scratchDir, `.musl-execinfo-patched.${LLAMA_CPP_COMMIT}`),
      ),
    ).toBe(true);
  });

  it("fails loudly when ggml.c doesn't contain the expected pre-image (drift detection)", () => {
    const file = path.join(scratchDir, "ggml", "src", "ggml.c");
    fs.writeFileSync(file, "// totally different code\n", "utf8");
    expect(() =>
      patchLlamaCppSourceForMusl({ srcDir: scratchDir, log: () => {} }),
    ).toThrow(/Could not locate expected execinfo\.h block/);
  });

  it("treats source patch as drift-detection when only one of guard/include is present", () => {
    const file = path.join(scratchDir, "ggml", "src", "ggml.c");
    // Has __GLIBC__ guard but no execinfo include — that's drift.
    fs.writeFileSync(
      file,
      "#if defined(__linux__) && defined(__GLIBC__)\n// no execinfo here\n",
      "utf8",
    );
    expect(() =>
      patchLlamaCppSourceForMusl({ srcDir: scratchDir, log: () => {} }),
    ).toThrow(/Could not locate expected execinfo\.h block/);
  });

  it("fails loudly when ggml.c is missing entirely", () => {
    expect(() =>
      patchLlamaCppSourceForMusl({ srcDir: scratchDir, log: () => {} }),
    ).toThrow(/Cannot patch ggml\.c/);
  });
});

describe("compile-libllama shim build invocation", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "compile-libllama-shim-test-"),
    );
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  function setUpFakeWorkspace() {
    // Fake llama include dir with both llama.h and ../ggml/include/ggml.h
    // because llama.h #include "ggml.h".
    const includeDir = path.join(scratchDir, "src", "include");
    const ggmlIncludeDir = path.join(scratchDir, "src", "ggml", "include");
    fs.mkdirSync(includeDir, { recursive: true });
    fs.mkdirSync(ggmlIncludeDir, { recursive: true });
    fs.writeFileSync(path.join(includeDir, "llama.h"), "// fake\n", "utf8");
    fs.writeFileSync(path.join(ggmlIncludeDir, "ggml.h"), "// fake\n", "utf8");
    // Fake asset dir with a libllama.so (truncated empty file is fine —
    // we never actually run the link step in unit tests).
    const abiAssetDir = path.join(scratchDir, "assets", "x86_64");
    fs.mkdirSync(abiAssetDir, { recursive: true });
    fs.writeFileSync(path.join(abiAssetDir, "libllama.so"), "", "utf8");
    // Fake shim source.
    const shimSourcePath = path.join(scratchDir, "shim", "eliza_llama_shim.c");
    fs.mkdirSync(path.dirname(shimSourcePath), { recursive: true });
    fs.writeFileSync(shimSourcePath, "/* fake */\n", "utf8");
    return { includeDir, abiAssetDir, shimSourcePath };
  }

  it("invokes the per-ABI zig driver with -shared/-fPIC and -lllama against the asset dir", () => {
    const { includeDir, abiAssetDir, shimSourcePath } = setUpFakeWorkspace();
    const captured: { command: string; args: string[] }[] = [];
    const fakeSpawn = (command: string, args: string[]) => {
      captured.push({ command, args });
      // Stub a successful compile by writing a non-empty shim output.
      const outIdx = args.indexOf("-o");
      if (outIdx >= 0 && outIdx + 1 < args.length) {
        // biome-ignore lint/style/noNonNullAssertion: spawn-stub bookkeeping
        fs.writeFileSync(args[outIdx + 1]!, "ELF-stub", "utf8");
      }
    };
    const out = buildShimForAbi({
      cacheDir: scratchDir,
      abi: "x86_64",
      abiAssetDir,
      shimSourcePath,
      llamaIncludeDir: includeDir,
      log: () => {},
      spawn: fakeSpawn,
    });
    expect(out).toBe(path.join(abiAssetDir, "libeliza-llama-shim.so"));
    expect(captured.length).toBeGreaterThan(0);
    // First call is the compile; second is the system strip fallback
    // (zig objcopy is invoked separately via the internal stripBinary
    // path which uses spawnSync directly, not the injected `spawn`).
    const compile = captured[0];
    expect(compile?.args).toContain("-shared");
    expect(compile?.args).toContain("-fPIC");
    expect(compile?.args).toContain("-O2");
    expect(compile?.args).toContain(`-I${includeDir}`);
    expect(compile?.args).toContain(`-L${abiAssetDir}`);
    expect(compile?.args).toContain("-lllama");
    expect(compile?.args).toContain(shimSourcePath);
    expect(compile?.args).toContain("-Wl,--disable-new-dtags");
    // Driver script path matches the ABI's zig-driver dir.
    expect(compile?.command).toBe(
      path.join(scratchDir, "zig-driver", "x86_64", "zig-cc"),
    );
  });

  /**
   * Regression for the AOSP runtime contract: the dynamic linker must
   * resolve libllama.so via LD_LIBRARY_PATH at runtime, NOT via a baked-in
   * RUNPATH that points at the build-host cache dir. Two failure modes the
   * test guards against:
   *
   * 1. Missing `-lllama` — without this, the shim has no NEEDED entry for
   *    libllama.so and every shim symbol that calls llama.cpp would
   *    dlsym to NULL on the device.
   *
   * 2. `-Wl,--enable-new-dtags` snuck back in — modern binutils default
   *    to RUNPATH (which is overridable by LD_LIBRARY_PATH) over
   *    DT_RPATH, but we still want to be explicit. RUNPATH baked from
   *    the build host (e.g. /home/shaw/...) would not exist on Android
   *    and the lookup would fail before LD_LIBRARY_PATH even gets a chance.
   */
  it("links shim against -lllama AND strips RUNPATH via --disable-new-dtags", () => {
    const { includeDir, abiAssetDir, shimSourcePath } = setUpFakeWorkspace();
    const captured: { command: string; args: string[] }[] = [];
    const fakeSpawn = (command: string, args: string[]) => {
      captured.push({ command, args });
      const outIdx = args.indexOf("-o");
      if (outIdx >= 0 && outIdx + 1 < args.length) {
        // biome-ignore lint/style/noNonNullAssertion: spawn-stub bookkeeping
        fs.writeFileSync(args[outIdx + 1]!, "ELF-stub", "utf8");
      }
    };
    buildShimForAbi({
      cacheDir: scratchDir,
      abi: "arm64-v8a",
      abiAssetDir,
      shimSourcePath,
      llamaIncludeDir: includeDir,
      log: () => {},
      spawn: fakeSpawn,
    });
    const compile = captured[0];
    expect(compile?.args).toBeDefined();
    if (!compile?.args) return;

    // -lllama must be present so the shim's NEEDED list includes libllama.so.
    // Without it, runtime dlopen of the shim would still succeed, but the
    // shim's calls into llama_*_default_params() / llama_*_load_from_file()
    // would resolve to NULL — a silent regression that only fires on
    // the device.
    expect(compile.args).toContain("-lllama");

    // Either the explicit --disable-new-dtags is present (current
    // behaviour) OR --enable-new-dtags is NOT present. We don't accept
    // the third option (no flag at all) because zig/lld defaults vary
    // across versions.
    const hasDisable = compile.args.includes("-Wl,--disable-new-dtags");
    const hasEnable = compile.args.includes("-Wl,--enable-new-dtags");
    expect(hasEnable).toBe(false);
    expect(hasDisable).toBe(true);

    // No -Wl,-rpath= flags (RUNPATH must come from LD_LIBRARY_PATH at
    // runtime, NOT from a baked-in build-host path).
    for (const arg of compile.args) {
      expect(arg).not.toMatch(/^-Wl,-rpath/);
      expect(arg).not.toMatch(/^-rpath/);
    }
  });

  it("fails loudly when the shim source is missing", () => {
    const { includeDir, abiAssetDir } = setUpFakeWorkspace();
    expect(() =>
      buildShimForAbi({
        cacheDir: scratchDir,
        abi: "x86_64",
        abiAssetDir,
        shimSourcePath: path.join(scratchDir, "no-such-file.c"),
        llamaIncludeDir: includeDir,
        log: () => {},
        spawn: () => {},
      }),
    ).toThrow(/Shim source not found/);
  });

  it("fails loudly when libllama.so is missing from the asset dir", () => {
    const { includeDir, shimSourcePath } = setUpFakeWorkspace();
    const emptyAssetDir = path.join(scratchDir, "no-llama");
    fs.mkdirSync(emptyAssetDir, { recursive: true });
    expect(() =>
      buildShimForAbi({
        cacheDir: scratchDir,
        abi: "x86_64",
        abiAssetDir: emptyAssetDir,
        shimSourcePath,
        llamaIncludeDir: includeDir,
        log: () => {},
        spawn: () => {},
      }),
    ).toThrow(/Cannot link shim/);
  });

  it("fails loudly when the ggml include dir is missing (header-chain drift)", () => {
    const { includeDir, abiAssetDir, shimSourcePath } = setUpFakeWorkspace();
    fs.rmSync(path.join(scratchDir, "src", "ggml"), {
      recursive: true,
      force: true,
    });
    expect(() =>
      buildShimForAbi({
        cacheDir: scratchDir,
        abi: "x86_64",
        abiAssetDir,
        shimSourcePath,
        llamaIncludeDir: includeDir,
        log: () => {},
        spawn: () => {},
      }),
    ).toThrow(/ggml\.h missing/);
  });
});

describe("compile-libllama pinned constants", () => {
  it("matches the SHA referenced in eliza/packages/agent/src/runtime/aosp-llama-adapter.ts", () => {
    // apothic/llama.cpp-1bit-turboquant @ main-b8198-b2b5273 — the fork
    // that adds TBQ3_0 / TBQ4_0 KV-cache codecs (CPU + CUDA). Based on
    // upstream b8198, so it inherits the post-2024 sampler-chain API and
    // the renamed model/vocab API the adapter binds against. The matching
    // Bonsai-8B-1bit GGUF on Hugging Face is trained against this fork.
    expect(LLAMA_CPP_TAG).toBe("main-b8198-b2b5273");
    expect(LLAMA_CPP_COMMIT).toBe("b2b5273e8b275bb96362fe844a5202632eb3e52b");
  });

  it("clones from the apothic fork (not stock ggml-org)", async () => {
    const mod = await import("./compile-libllama.mjs");
    expect(mod.LLAMA_CPP_REMOTE).toBe(
      "https://github.com/Apothic-AI/llama.cpp-1bit-turboquant.git",
    );
  });

  it("declares a target row for each supported Android ABI", () => {
    expect(ABI_TARGETS.map((t) => t.androidAbi)).toEqual([
      "arm64-v8a",
      "x86_64",
    ]);
    for (const target of ABI_TARGETS) {
      expect(target.zigTarget).toMatch(/^(aarch64|x86_64)-linux-musl$/);
      expect(target.cmakeProcessor).toMatch(/^(aarch64|x86_64)$/);
    }
  });
});
