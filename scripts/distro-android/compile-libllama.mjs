#!/usr/bin/env node
/**
 * compile-libllama.mjs — cross-compile llama.cpp into a musl-linked
 * libllama.so for the AOSP-bound brand APK.
 *
 * Brand-aware: the assets dir and cache dir defaults come from the
 * brand config (`androidAssetsDir`, `cacheDirName`). Override either
 * with --assets-dir / --cache-dir.
 *
 * Why musl, not the regular Android NDK toolchain:
 *   The brand's AOSP build ships a self-contained bun-on-Android
 *   process. That process loads bun-linux-{x64,aarch64}-musl from
 *   inside the APK, runs through ld-musl-{x86_64,aarch64}.so.1 (the
 *   Alpine musl loader), and links libstdc++.so.6 / libgcc_s.so.1
 *   from Alpine v3.21. It is not bionic. NDK clang produces
 *   bionic-linked ELFs that depend on libc.so / libdl.so symbols the
 *   musl loader doesn't expose, so dlopen() of an NDK-compiled
 *   libllama.so inside the bun process fails with "undefined symbol"
 *   the moment libllama touches a libc primitive.
 *
 *   Requirement: libllama.so MUST be a musl-linked shared object
 *   whose external dependencies are limited to ld-musl,
 *   libstdc++.so.6, and libgcc_s.so.1 — all three of which the APK
 *   already ships per ABI.
 *
 * Toolchain choice:
 *   We use `zig cc --target={aarch64,x86_64}-linux-musl` for cross-
 *   compilation. Zig bundles a complete musl libc, libc++, and
 *   cross-toolchain for both architectures, which avoids the
 *   (otherwise multi-step) work of building a musl-cross-make
 *   toolchain on the build host. Bun itself uses zig for its musl
 *   Android targets, so the resulting ABI matches what bun expects
 *   when it dlopen()s libllama.so via bun:ffi at runtime.
 *
 *   Minimum tested: zig 0.13.0. Earlier versions ship older libc++
 *   headers that miss <bit> / <span> shims llama.cpp's CMake feature
 *   checks rely on.
 *
 * Output:
 *   <androidAssetsDir>/arm64-v8a/libllama.so   (real phones)
 *   <androidAssetsDir>/x86_64/libllama.so      (cuttlefish + emulators)
 *
 * Idempotent: cached clone + cached build dirs skip rework. Bumping
 * the pinned tag in LLAMA_CPP_TAG / LLAMA_CPP_COMMIT busts the cache.
 *
 * Failure mode:
 *   If zig is missing, this script exits with code 1 and prints the
 *   exact install command. We never silently skip — an APK that
 *   ships without libllama.so but with <BRAND>_LOCAL_LLAMA=1 would
 *   fail at first inference call.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBrandFromArgv } from "./brand-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

export const LLAMA_CPP_TAG = "b3490";
export const LLAMA_CPP_COMMIT = "6e2b6000e5fe808954a7dcef8225b5b7f2c1b9e9";
export const LLAMA_CPP_REMOTE = "https://github.com/ggml-org/llama.cpp.git";
export const MIN_ZIG_VERSION = "0.13.0";

export const ABI_TARGETS = [
  {
    androidAbi: "arm64-v8a",
    zigTarget: "aarch64-linux-musl",
    cmakeProcessor: "aarch64",
  },
  {
    androidAbi: "x86_64",
    zigTarget: "x86_64-linux-musl",
    cmakeProcessor: "x86_64",
  },
];

function defaultAssetsDir(brand) {
  if (brand.androidAssetsDir) {
    return path.resolve(repoRoot, brand.androidAssetsDir);
  }
  return path.join(
    repoRoot,
    "packages",
    "app",
    "android",
    "app",
    "src",
    "main",
    "assets",
    "agent",
  );
}

function defaultCacheDir(brand) {
  const cacheName = brand.cacheDirName ?? `${brand.brand}-android-agent`;
  return path.join(
    os.homedir(),
    ".cache",
    cacheName,
    `llama-cpp-${LLAMA_CPP_TAG}`,
  );
}

export function parseSubArgs(argv, brand) {
  const args = {
    androidAssetsDir: defaultAssetsDir(brand),
    cacheDir: defaultCacheDir(brand),
    abis: ABI_TARGETS.map((t) => t.androidAbi),
    skipIfPresent: false,
    jobs: Math.max(1, Math.min(os.cpus().length, 8)),
    srcDir: null,
  };

  const readFlagValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--assets-dir") {
      args.androidAssetsDir = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--cache-dir") {
      args.cacheDir = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--src-dir") {
      args.srcDir = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--abi") {
      const value = readFlagValue(arg, i);
      const valid = ABI_TARGETS.map((t) => t.androidAbi);
      if (!valid.includes(value)) {
        throw new Error(
          `--abi must be one of ${valid.join(", ")} (got: ${value})`,
        );
      }
      args.abis = [value];
      i += 1;
    } else if (arg === "--jobs" || arg === "-j") {
      const value = Number.parseInt(readFlagValue(arg, i), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--jobs must be a positive integer");
      }
      args.jobs = value;
      i += 1;
    } else if (arg === "--skip-if-present") {
      args.skipIfPresent = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/distro-android/compile-libllama.mjs [--brand-config <PATH>] " +
          "[--assets-dir <PATH>] [--cache-dir <PATH>] [--src-dir <PATH>] " +
          "[--abi <arm64-v8a|x86_64>] [--jobs <N>] [--skip-if-present]\n" +
          "  --src-dir <PATH>  Use an existing llama.cpp / buun-llama-cpp checkout instead\n" +
          "                    of cloning. The directory's HEAD is used as-is; the pinned\n" +
          "                    LLAMA_CPP_TAG/COMMIT in this script is ignored.",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

/**
 * Compare two semver-ish version strings.
 */
export function compareSemver(a, b) {
  const norm = (v) =>
    String(v)
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const aa = norm(a);
  const bb = norm(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Probe the build host for a usable zig toolchain.
 */
export function probeZig({
  spawn = spawnSync,
  platform = process.platform,
} = {}) {
  const probe = spawn("zig", ["version"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0) {
    const installHint =
      platform === "darwin"
        ? "brew install zig"
        : platform === "linux"
          ? "snap install zig --classic --beta\n  or download a tarball from https://ziglang.org/download/ and put `zig` on PATH"
          : "see https://ziglang.org/download/";
    throw new Error(
      `[compile-libllama] zig is required to cross-compile libllama.so for the AOSP build, but was not found on PATH.\n` +
        `Install zig >= ${MIN_ZIG_VERSION} and re-run:\n  ${installHint}\n` +
        `(zig is what we use to produce musl-linked binaries that match the bun-on-Android runtime ABI; ` +
        `the regular Android NDK clang produces bionic-linked binaries that the musl loader cannot dlopen.)`,
    );
  }
  const version = probe.stdout.trim();
  if (compareSemver(version, MIN_ZIG_VERSION) < 0) {
    throw new Error(
      `[compile-libllama] zig ${version} is too old; need >= ${MIN_ZIG_VERSION}.\n` +
        `Earlier zig releases ship libc++ headers that miss the <bit>/<span> shims llama.cpp ` +
        `feature-checks during configure. Upgrade zig and re-run.`,
    );
  }
  return version;
}

function run(command, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with code ${result.status}`,
    );
  }
}

export function ensureLlamaCppCheckout({
  cacheDir,
  log = console.log,
  spawn = run,
}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const sentinel = path.join(cacheDir, `.checked-out.${LLAMA_CPP_COMMIT}`);
  if (
    fs.existsSync(sentinel) &&
    fs.existsSync(path.join(cacheDir, "CMakeLists.txt"))
  ) {
    log(`[compile-libllama] Reusing cached llama.cpp checkout at ${cacheDir}`);
    return cacheDir;
  }
  if (!fs.existsSync(path.join(cacheDir, ".git"))) {
    log(
      `[compile-libllama] Cloning llama.cpp ${LLAMA_CPP_TAG} into ${cacheDir}`,
    );
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    spawn(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        LLAMA_CPP_TAG,
        LLAMA_CPP_REMOTE,
        cacheDir,
      ],
      {},
    );
  } else {
    log(`[compile-libllama] Refreshing llama.cpp checkout in ${cacheDir}`);
    spawn("git", ["fetch", "--depth", "1", "origin", `tag`, LLAMA_CPP_TAG], {
      cwd: cacheDir,
    });
  }
  spawn("git", ["checkout", "--detach", LLAMA_CPP_COMMIT], { cwd: cacheDir });
  fs.writeFileSync(sentinel, `${LLAMA_CPP_COMMIT}\n`, "utf8");
  return cacheDir;
}

export function buildLibllamaForAbi({
  srcDir,
  abi,
  abiAssetDir,
  jobs,
  zigBin = "zig",
  log = console.log,
  spawn = run,
}) {
  const target = ABI_TARGETS.find((t) => t.androidAbi === abi);
  if (!target) {
    throw new Error(`[compile-libllama] Unknown ABI: ${abi}`);
  }
  const buildDir = path.join(srcDir, `build-${abi}`);
  fs.mkdirSync(buildDir, { recursive: true });

  const cFlags = `--target=${target.zigTarget}`;
  const cxxFlags = cFlags;

  log(
    `[compile-libllama] Configuring llama.cpp for ${abi} (${target.zigTarget}) in ${buildDir}`,
  );
  spawn(
    "cmake",
    [
      "-S",
      srcDir,
      "-B",
      buildDir,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DBUILD_SHARED_LIBS=ON",
      "-DLLAMA_BUILD_EXAMPLES=OFF",
      "-DLLAMA_BUILD_TESTS=OFF",
      "-DLLAMA_BUILD_SERVER=OFF",
      `-DCMAKE_C_COMPILER=${zigBin}`,
      `-DCMAKE_CXX_COMPILER=${zigBin}`,
      "-DCMAKE_C_COMPILER_LAUNCHER=",
      "-DCMAKE_CXX_COMPILER_LAUNCHER=",
      `-DCMAKE_C_FLAGS=${cFlags}`,
      `-DCMAKE_CXX_FLAGS=${cxxFlags}`,
      "-DCMAKE_SYSTEM_NAME=Linux",
      `-DCMAKE_SYSTEM_PROCESSOR=${target.cmakeProcessor}`,
      "-DGGML_NATIVE=OFF",
    ],
    {},
  );

  log(`[compile-libllama] Compiling libllama for ${abi} with -j${jobs}`);
  spawn(
    "cmake",
    ["--build", buildDir, "--target", "llama", "-j", String(jobs)],
    {},
  );

  const built = locateBuiltLibllama(buildDir);
  if (!built) {
    throw new Error(
      `[compile-libllama] Could not locate built libllama.so anywhere under ${buildDir}.`,
    );
  }
  fs.mkdirSync(abiAssetDir, { recursive: true });
  const target_so = path.join(abiAssetDir, "libllama.so");
  fs.copyFileSync(built, target_so);

  const stripped = stripBinary({ filePath: target_so, zigBin, log });
  if (stripped) {
    log(
      `[compile-libllama] Stripped libllama.so for ${abi} (size now ${fs.statSync(target_so).size} bytes).`,
    );
  }
  return target_so;
}

function locateBuiltLibllama(buildDir) {
  const candidates = [
    path.join(buildDir, "src", "libllama.so"),
    path.join(buildDir, "libllama.so"),
    path.join(buildDir, "bin", "libllama.so"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const stack = [buildDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "_deps" || entry.name.startsWith(".")) continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === "libllama.so") {
        return path.join(dir, entry.name);
      }
    }
  }
  return null;
}

function stripBinary({ filePath, zigBin, log }) {
  const zigStripResult = spawnSync(
    zigBin,
    ["objcopy", "--strip-all", filePath, filePath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (zigStripResult.status === 0) return true;
  const systemStripResult = spawnSync("strip", ["--strip-all", filePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (systemStripResult.status === 0) return true;
  log(
    `[compile-libllama] WARN: could not strip ${filePath}; shipping with debug symbols.`,
  );
  return false;
}

export async function main(argv = process.argv.slice(2)) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const args = parseSubArgs(remaining, brand);

  const zigVersion = probeZig();
  console.log(`[compile-libllama] Found zig ${zigVersion}`);

  let allPresent = true;
  for (const abi of args.abis) {
    const out = path.join(args.androidAssetsDir, abi, "libllama.so");
    if (!fs.existsSync(out)) {
      allPresent = false;
      break;
    }
  }
  if (args.skipIfPresent && allPresent) {
    console.log(
      "[compile-libllama] All requested libllama.so files already present; --skip-if-present honoured.",
    );
    return;
  }

  let srcDir;
  let srcDescription;
  if (args.srcDir) {
    if (!fs.existsSync(path.join(args.srcDir, "CMakeLists.txt"))) {
      throw new Error(
        `[compile-libllama] --src-dir ${args.srcDir} does not contain a CMakeLists.txt; ` +
          `expected a llama.cpp / buun-llama-cpp checkout.`,
      );
    }
    srcDir = args.srcDir;
    const headFile = path.join(srcDir, ".git", "HEAD");
    let headRef = "(unknown)";
    try {
      headRef = fs.readFileSync(headFile, "utf8").trim();
    } catch {}
    console.log(
      `[compile-libllama] Using --src-dir ${srcDir} (HEAD: ${headRef}); ` +
        `pinned tag ${LLAMA_CPP_TAG} ignored.`,
    );
    srcDescription = `external src-dir ${srcDir}`;
  } else {
    srcDir = ensureLlamaCppCheckout({
      cacheDir: args.cacheDir,
      log: console.log,
      spawn: run,
    });
    srcDescription = `llama.cpp ${LLAMA_CPP_TAG} / ${LLAMA_CPP_COMMIT.slice(0, 12)}`;
  }

  for (const abi of args.abis) {
    const abiAssetDir = path.join(args.androidAssetsDir, abi);
    buildLibllamaForAbi({
      srcDir,
      abi,
      abiAssetDir,
      jobs: args.jobs,
      log: console.log,
      spawn: run,
    });
  }

  console.log(
    `[compile-libllama] Built libllama.so for ${args.abis.join(", ")} (${srcDescription}).`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
