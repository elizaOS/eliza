/**
 * Phase A staging for the on-device agent runtime on Android.
 *
 * Lays the bun binary, the matching musl loader, libstdc++, libgcc, and the
 * launcher + agent bundle inside the APK assets tree so that
 * `ElizaAgentService` (Phase B) can copy them out to the app data dir at
 * first launch and `execve()` bun there. Without this stage the APK ships
 * with no executable runtime and the local-agent mode cannot start.
 *
 * Layout produced under `packages/app/android/app/src/main/assets/agent/`:
 *
 *   agent-bundle.js                 (ABI-independent entry point; placeholder
 *                                    until Phase D replaces it with the real
 *                                    @elizaos/agent bundle)
 *   launch.sh                       (ABI-independent device-side launcher,
 *                                    a parameterised double-fork daemoniser)
 *   x86_64/bun                      (cuttlefish + x86_64 emulator)
 *   x86_64/ld-musl-x86_64.so.1
 *   x86_64/libstdc++.so.6.0.33
 *   x86_64/libgcc_s.so.1
 *   arm64-v8a/bun                   (real phones)
 *   arm64-v8a/ld-musl-aarch64.so.1
 *   arm64-v8a/libstdc++.so.6.0.33
 *   arm64-v8a/libgcc_s.so.1
 *
 * Downloads are cached under `~/.cache/eliza-android-agent/<bun-version>/`
 * and the staging step is idempotent — already-staged files with the
 * matching size are left in place.
 *
 * Pinned versions (mirrors scripts/spike-android-agent/bootstrap.sh):
 *   - bun 1.3.13                     proven on the Phase 0 spike
 *   - Alpine v3.21                   ships gcc 14.2 → libstdc++.so.6.0.33
 *
 * The ABI-independent `launch.sh` and `agent-bundle.js` placeholder are
 * derived from `scripts/spike-android-agent/launch-on-device.sh` and
 * `scripts/spike-android-agent/server.js` respectively. Phase D replaces
 * `agent-bundle.js` with the real bundled runtime.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUN_VERSION = "1.3.13";
// Bun 1.3.13 has a segfault we hit during inference on Cuttlefish at
// peak ~2.3 GB RSS ("panic(main thread): Segmentation fault at address
// 0x5420"). The canary channel ships the upstream fix while we wait for
// 1.3.14+. MILADY_BUN_CHANNEL=stable forces back to BUN_VERSION; default
// is canary so AOSP/cvd inference doesn't crash mid-token.
const BUN_CHANNEL = (process.env.MILADY_BUN_CHANNEL ?? "canary").toLowerCase();
const ALPINE_BRANCH = "v3.21";

/**
 * Default cache dir for compile-shim.mjs's outputs. Mirrors the default
 * in `scripts/elizaos/compile-shim.mjs`. We resolve from `os.homedir()`
 * directly instead of importing `compile-shim.mjs` to avoid pulling the
 * zig probe + shell-out machinery into the staging step (this module
 * runs unconditionally on every gradle build, not just AOSP).
 */
const SECCOMP_SHIM_CACHE_DIR = path.join(
  os.homedir(),
  ".cache",
  "eliza-android-agent",
  "seccomp-shim",
);

const ABI_TARGETS = [
  {
    androidAbi: "x86_64",
    bunArch: "x64",
    alpineArch: "x86_64",
    ldName: "ld-musl-x86_64.so.1",
  },
  {
    androidAbi: "arm64-v8a",
    bunArch: "aarch64",
    alpineArch: "aarch64",
    ldName: "ld-musl-aarch64.so.1",
  },
];

const APK_PACKAGES = [
  { pkg: "musl", file: "musl.apk" },
  { pkg: "libstdc++", file: "libstdcxx.apk" },
  { pkg: "libgcc", file: "libgcc.apk" },
];

function jniLoaderName(ldName) {
  if (ldName.includes("aarch64")) return "libeliza_ld_musl_aarch64.so";
  if (ldName.includes("x86_64")) return "libeliza_ld_musl_x86_64.so";
  return `libeliza_${ldName.replace(/[^a-zA-Z0-9]+/g, "_")}.so`;
}

// Sibling JNI-lib name for the SIGSYS-shim'd "real" musl loader. The
// loader-wrap binary at jniLoaderName(ldName) detects this layout (".so"
// → "_real.so") so it can find the underlying musl loader without falling
// back to the agent data dir (untrusted_app SELinux denies execve there).
function jniRealLoaderName(ldName) {
  return jniLoaderName(ldName).replace(/\.so$/, "_real.so");
}

/**
 * Adapted from scripts/spike-android-agent/launch-on-device.sh. The script
 * ships *inside* the APK and is copied (with executable bit set) into the
 * app data dir by ElizaAgentService at first launch. It accepts the device
 * path, ABI-specific musl loader, and listen port as env vars so a single
 * shell file can drive both ABIs at runtime.
 */
const LAUNCH_SCRIPT = `#!/system/bin/sh
# launch.sh — device-side launcher for the on-device Eliza agent.
#
# Staged into the APK by run-mobile-build.mjs and copied to the app's
# private data dir by ElizaAgentService on first launch. Daemonises bun
# via a setsid double-fork so the agent survives the service that kicked
# it off; without that adb shell / Service.onCreate parents reap it.
#
# Required env vars:
#   DEVICE_DIR  Absolute path on the device that holds bun + musl + bundle.
#   LD_NAME     Per-ABI musl loader filename (ld-musl-{x86_64,aarch64}.so.1).
#   PORT        Loopback port for Bun.serve() to bind 127.0.0.1 on.
#
# Optional:
#   AGENT_BUNDLE  Defaults to "agent-bundle.js" in DEVICE_DIR.
#   LOG_FILE      Defaults to "agent.log" in DEVICE_DIR.

DEVICE_DIR=\${DEVICE_DIR:-/data/local/tmp}
LD_NAME=\${LD_NAME:-ld-musl-x86_64.so.1}
PORT=\${PORT:-31337}
AGENT_BUNDLE=\${AGENT_BUNDLE:-agent-bundle.js}
LOG_FILE=\${LOG_FILE:-\${DEVICE_DIR}/agent.log}

cd "$DEVICE_DIR" || exit 1
pkill -f "\${DEVICE_DIR}/bun" 2>/dev/null
sleep 1

(
  setsid sh -c "exec </dev/null >\\"$LOG_FILE\\" 2>&1; LD_LIBRARY_PATH=\\"$DEVICE_DIR\\" PORT=\\"$PORT\\" exec \\"$DEVICE_DIR/$LD_NAME\\" \\"$DEVICE_DIR/bun\\" \\"$DEVICE_DIR/$AGENT_BUNDLE\\"" &
) &
disown 2>/dev/null || true
exit 0
`;

function logFor(log) {
  return (msg) => log(`[mobile-build] ${msg}`);
}

function run(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`${command} killed by ${signal}`));
      if ((code ?? 1) !== 0) {
        return reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code ?? 1}: ${stderr.trim()}`,
          ),
        );
      }
      resolve();
    });
    child.on("error", reject);
  });
}

async function downloadFile(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buf);
}

async function ensureBunBinary({ cacheDir, bunArch, log }) {
  const channelTag =
    BUN_CHANNEL === "canary" ? "canary" : `bun-${BUN_VERSION}`;
  const cacheKey = BUN_CHANNEL === "canary" ? "canary" : BUN_VERSION;
  const archCache = path.join(cacheDir, `bun-${bunArch}-${cacheKey}`);
  const bunPath = path.join(archCache, "bun");
  // Canary cache invalidates after 24h so we pull bug-fix snapshots
  // automatically without forcing every CI run to re-download.
  const isFresh = (() => {
    if (!fs.existsSync(bunPath)) return false;
    const st = fs.statSync(bunPath);
    if (st.size <= 1_000_000) return false;
    if (BUN_CHANNEL !== "canary") return true;
    const ageMs = Date.now() - st.mtimeMs;
    return ageMs < 24 * 60 * 60 * 1000;
  })();
  if (isFresh) return bunPath;
  fs.mkdirSync(archCache, { recursive: true });
  const zipPath = path.join(archCache, "bun.zip");
  const url =
    BUN_CHANNEL === "canary"
      ? `https://github.com/oven-sh/bun/releases/download/canary/bun-linux-${bunArch}-musl.zip`
      : `https://github.com/oven-sh/bun/releases/download/${channelTag}/bun-linux-${bunArch}-musl.zip`;
  const channelLabel =
    BUN_CHANNEL === "canary" ? "bun-canary" : `bun-${BUN_VERSION}`;
  log(`Downloading ${channelLabel} (${bunArch}-musl) from ${url}`);
  await downloadFile(url, zipPath);
  await run("unzip", ["-q", "-o", zipPath, "-d", archCache]);
  const extractedDir = path.join(archCache, `bun-linux-${bunArch}-musl`);
  const extractedBun = path.join(extractedDir, "bun");
  if (!fs.existsSync(extractedBun)) {
    throw new Error(`bun zip did not contain bun at ${extractedBun}`);
  }
  if (fs.existsSync(bunPath)) fs.unlinkSync(bunPath);
  fs.renameSync(extractedBun, bunPath);
  fs.rmSync(extractedDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.chmodSync(bunPath, 0o755);
  return bunPath;
}

/**
 * Resolve the actual versioned filename of an Alpine package in the branch's
 * apk index. The package name is regex-escaped because libstdc++ contains a
 * `+`, which would otherwise eat the trailing characters and over-match.
 */
async function resolveAlpineApkUrl({ pkg, alpineArch }) {
  const indexUrl = `https://dl-cdn.alpinelinux.org/alpine/${ALPINE_BRANCH}/main/${alpineArch}/`;
  const response = await fetch(indexUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} listing ${indexUrl}`);
  }
  const html = await response.text();
  const escaped = pkg.replace(/[.[\\*^$()+?{|]/g, "\\$&");
  const re = new RegExp(`(${escaped}-[0-9][^"<\\s]*\\.apk)`);
  const match = html.match(re);
  if (!match) {
    throw new Error(
      `Could not find ${pkg} apk in alpine ${ALPINE_BRANCH} ${alpineArch} index`,
    );
  }
  return `${indexUrl}${match[1]}`;
}

async function ensureAlpineApkExtracted({ cacheDir, alpineArch, log }) {
  const archCache = path.join(cacheDir, `alpine-${alpineArch}`);
  const extractDir = path.join(archCache, "extract");
  const sentinel = path.join(archCache, ".extracted");
  if (
    fs.existsSync(sentinel) &&
    fs.existsSync(path.join(extractDir, "lib")) &&
    fs.existsSync(path.join(extractDir, "usr", "lib"))
  ) {
    return extractDir;
  }
  fs.mkdirSync(archCache, { recursive: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  for (const { pkg, file } of APK_PACKAGES) {
    const apkPath = path.join(archCache, file);
    if (!fs.existsSync(apkPath)) {
      const url = await resolveAlpineApkUrl({ pkg, alpineArch });
      log(`Downloading ${pkg} (${alpineArch}) from ${url}`);
      await downloadFile(url, apkPath);
    }
    // Alpine apks are gzipped tarballs with a small leading signature
    // section; GNU tar happily skips it and extracts the data section.
    await run("tar", ["-xzf", apkPath, "-C", extractDir]).catch(() => {
      // Some apks (notably musl) emit warnings on the signature header but
      // still extract the data correctly. Re-check via the expected files
      // below before treating this as a hard failure.
    });
  }
  fs.writeFileSync(sentinel, "ok");
  return extractDir;
}

function findLibstdcxxRealFile(extractDir) {
  const usrLib = path.join(extractDir, "usr", "lib");
  if (!fs.existsSync(usrLib)) {
    throw new Error(`libstdc++ extract missing usr/lib in ${extractDir}`);
  }
  const candidates = fs
    .readdirSync(usrLib)
    .filter((name) => /^libstdc\+\+\.so\.6\.0\.\d+$/.test(name));
  if (candidates.length === 0) {
    throw new Error(
      `Could not find libstdc++.so.6.0.* in ${usrLib} — Alpine ${ALPINE_BRANCH} layout changed?`,
    );
  }
  candidates.sort();
  return candidates[candidates.length - 1];
}

function copyIfDifferent(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`expected source file missing: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    const a = fs.statSync(source);
    const b = fs.statSync(target);
    if (a.size === b.size && a.mtimeMs <= b.mtimeMs) return false;
  }
  fs.copyFileSync(source, target);
  return true;
}

function writeIfChanged(target, content) {
  if (fs.existsSync(target)) {
    const current = fs.readFileSync(target, "utf8");
    if (current === content) return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return true;
}

/**
 * If `compile-shim.mjs` has produced shim + loader-wrap artifacts in the
 * cache for this ABI, stage them into the assets dir:
 *
 *   - Move existing `<ldName>` (the Alpine-extracted real loader) to
 *     `<ldName>.real`. We freshen this on every run so the wrapper
 *     always points at an up-to-date loader.
 *   - Drop our compiled `loader-wrap` in as `<ldName>`.
 *   - Drop `libsigsys-handler.so` next to it.
 *
 * Returns the number of files changed this call (0 when nothing
 * happened). When no compiled shim exists for the ABI we no-op and
 * return 0 — the Capacitor APK build path keeps the legacy loader.
 *
 * Exported for testing.
 */
export function stageSeccompShimForAbi({
  androidAbi,
  ldName,
  abiAssetsDir,
  cacheDir = SECCOMP_SHIM_CACHE_DIR,
  log,
}) {
  const abiCacheDir = path.join(cacheDir, androidAbi);
  const cachedWrap = path.join(abiCacheDir, ldName);
  const cachedShim = path.join(abiCacheDir, "libsigsys-handler.so");
  if (!fs.existsSync(cachedWrap) || !fs.existsSync(cachedShim)) {
    log?.(
      `No compiled SIGSYS shim for ${androidAbi}; leaving the Alpine ` +
        `loader at ${ldName} (run \`node scripts/elizaos/compile-shim.mjs\` for ` +
        `the AOSP path).`,
    );
    return 0;
  }

  const stagedLoader = path.join(abiAssetsDir, ldName);
  const stagedRealLoader = `${stagedLoader}.real`;
  const stagedShim = path.join(abiAssetsDir, "libsigsys-handler.so");

  let changes = 0;

  // Detect whether the existing `<ldName>` is the Alpine loader (which
  // we need to relocate to .real) or our wrapper (already in place from
  // a prior run). The wrapper is a tiny static binary (~30 KB on
  // x86_64-linux-musl); the Alpine loader is ~600 KB. A size check is
  // good enough as a discriminator and avoids shelling out to readelf.
  const ALPINE_LOADER_MIN_BYTES = 200 * 1024;
  const stagedLoaderExists = fs.existsSync(stagedLoader);
  const stagedLoaderIsAlpine =
    stagedLoaderExists &&
    fs.statSync(stagedLoader).size >= ALPINE_LOADER_MIN_BYTES;

  if (stagedLoaderIsAlpine) {
    // Move the Alpine loader to .real so the wrapper can exec it. Use
    // copy-then-delete so a partial failure still leaves a working .real.
    fs.copyFileSync(stagedLoader, stagedRealLoader);
    fs.rmSync(stagedLoader);
    changes += 1;
    log?.(`Renamed Alpine ${ldName} → ${ldName}.real for ${androidAbi}.`);
  } else if (!fs.existsSync(stagedRealLoader)) {
    // Edge case: our wrapper is already in place but the .real
    // loader is missing. The freshly-staged Alpine loader was
    // overwritten with the wrapper before we could relocate it, or
    // the cache dir was wiped. Refuse to stage a wrapper without a
    // real loader to chain to — execve would fail at runtime with
    // ENOENT and the agent would silently never come up.
    throw new Error(
      `[stage-android-agent] ${ldName}.real is missing under ${abiAssetsDir} ` +
        `but the wrapper is already in place. Wipe the assets dir and re-run ` +
        `stageAndroidAgentRuntime to repopulate the Alpine loader before staging the shim.`,
    );
  }

  // Stage the wrapper as <ldName>.
  if (copyIfDifferent(cachedWrap, stagedLoader)) changes += 1;
  // Stage libsigsys-handler.so alongside.
  if (copyIfDifferent(cachedShim, stagedShim)) changes += 1;

  if (changes > 0) {
    log?.(
      `Installed SIGSYS shim for ${androidAbi}: wrapper ${ldName} + ` +
        `libsigsys-handler.so (real loader at ${ldName}.real).`,
    );
  }
  return changes;
}

/**
 * Download (if needed) and stage the on-device agent runtime into the
 * Android assets tree. Idempotent — safe to run on every gradle invocation.
 *
 * Required:
 *   androidDir  Absolute path to packages/app/android/.
 *   spikeDir    Absolute path to scripts/spike-android-agent/ (source of
 *               the placeholder agent-bundle.js until Phase D wires up the
 *               real @elizaos/agent bundle).
 *
 * Optional:
 *   cacheDir    Defaults to ~/.cache/eliza-android-agent/<bun-version>/.
 *   log         Defaults to console.log.
 */
export async function stageAndroidAgentRuntime({
  androidDir,
  spikeDir,
  cacheDir = path.join(
    os.homedir(),
    ".cache",
    "eliza-android-agent",
    `bun-${BUN_CHANNEL === "canary" ? "canary" : BUN_VERSION}`,
  ),
  log = console.log,
} = {}) {
  if (!androidDir)
    throw new Error("stageAndroidAgentRuntime: androidDir is required");
  if (!spikeDir)
    throw new Error("stageAndroidAgentRuntime: spikeDir is required");

  const tlog = logFor(log);
  fs.mkdirSync(cacheDir, { recursive: true });

  // Runtime files ship under `assets/agent/{abi}/` for AOSP builds that can
  // execute from priv-app data, and under `jniLibs/{abi}/libeliza_*.so` for
  // stock Capacitor builds where SELinux denies execute_no_trans from app
  // writable data. ElizaAgentService prefers the packaged native-library
  // copies when present and falls back to the extracted assets on AOSP.
  const assetsAgentDir = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "assets",
    "agent",
  );
  fs.mkdirSync(assetsAgentDir, { recursive: true });
  const jniLibsDir = path.join(androidDir, "app", "src", "main", "jniLibs");
  fs.mkdirSync(jniLibsDir, { recursive: true });

  let stagedCount = 0;

  for (const target of ABI_TARGETS) {
    const { androidAbi, bunArch, alpineArch, ldName } = target;
    const abiAssetsDir = path.join(assetsAgentDir, androidAbi);
    const abiJniDir = path.join(jniLibsDir, androidAbi);
    fs.mkdirSync(abiAssetsDir, { recursive: true });
    fs.mkdirSync(abiJniDir, { recursive: true });

    const bunPath = await ensureBunBinary({ cacheDir, bunArch, log: tlog });
    const extractDir = await ensureAlpineApkExtracted({
      cacheDir,
      alpineArch,
      log: tlog,
    });

    const libstdcxxFile = findLibstdcxxRealFile(extractDir);

    const sources = [
      [bunPath, path.join(abiAssetsDir, "bun")],
      [path.join(extractDir, "lib", ldName), path.join(abiAssetsDir, ldName)],
      [
        path.join(extractDir, "usr", "lib", libstdcxxFile),
        path.join(abiAssetsDir, libstdcxxFile),
      ],
      [
        path.join(extractDir, "usr", "lib", "libgcc_s.so.1"),
        path.join(abiAssetsDir, "libgcc_s.so.1"),
      ],
    ];

    let abiChanges = 0;
    for (const [src, dst] of sources) {
      if (copyIfDifferent(src, dst)) abiChanges += 1;
    }

    // llama-server is produced by compile-libllama.mjs (per-ABI). It already
    // lands at <abiAssetsDir>/llama-server when that script ran successfully,
    // so we don't re-copy here — but we do ensure the bit is +x because some
    // file-copy paths (e.g. zip → unzip on Windows builders) lose the
    // executable bit. The aosp-llama-adapter spawns it for DFlash decode;
    // without +x exec fails with EACCES at runtime.
    const llamaServerStaged = path.join(abiAssetsDir, "llama-server");
    if (fs.existsSync(llamaServerStaged)) {
      const mode = fs.statSync(llamaServerStaged).mode;
      if ((mode & 0o111) !== 0o111) {
        fs.chmodSync(llamaServerStaged, mode | 0o755);
        abiChanges += 1;
        tlog(`Restored +x on ${androidAbi}/llama-server.`);
      }
    } else {
      tlog(
        `No llama-server staged for ${androidAbi}; DFlash spec-decode on AOSP ` +
          `will fall back to single-model decode. Run \`node ` +
          `packages/app-core/scripts/aosp/compile-libllama.mjs\` to build it.`,
      );
    }

    // Per-ABI seccomp shim install. Both x86_64 (legacy non-AT syscalls)
    // and arm64-v8a (the new-syscall case — bun's `epoll_pwait2` blocked
    // by Android's `untrusted_app` filter) have compiled shim artifacts.
    // When the artifacts exist:
    //   1. Stage `libsigsys-handler.so` next to bun.
    //   2. Rename the Alpine-extracted ld-musl-*.so.1 → .so.1.real.
    //   3. Stage our `loader-wrap` ELF as ld-musl-*.so.1.
    // ElizaAgentService.java's existing findMuslLoader + ProcessBuilder
    // spawn line then transparently picks up the wrapper, which prepends
    // libsigsys-handler.so to LD_PRELOAD before exec'ing the real loader.
    //
    // Idempotent: if the wrapper is already in place we just refresh
    // the .real loader and the shim file (handled by copyIfDifferent's
    // size+mtime check). If shim artifacts are missing we leave the
    // legacy loader in place so the Capacitor APK build still works.
    const shimChanges = stageSeccompShimForAbi({
      androidAbi,
      ldName,
      abiAssetsDir,
      log: tlog,
    });
    abiChanges += shimChanges;

    const jniSources = [
      [path.join(abiAssetsDir, "bun"), path.join(abiJniDir, "libeliza_bun.so")],
      [
        path.join(abiAssetsDir, ldName),
        path.join(abiJniDir, jniLoaderName(ldName)),
      ],
      [
        path.join(abiAssetsDir, libstdcxxFile),
        path.join(abiJniDir, "libeliza_stdcpp.so"),
      ],
      [
        path.join(abiAssetsDir, "libgcc_s.so.1"),
        path.join(abiJniDir, "libeliza_gcc_s.so"),
      ],
    ];
    // When the seccomp-shim is in play (x86_64), `<ldName>` in
    // `abiAssetsDir/` is the loader-wrap binary and the real musl loader
    // sits next to it as `<ldName>.real`. ElizaAgentService swaps the
    // wrapper for its packaged JNI-lib copy at exec time, so the wrapper
    // ends up running from `<install>/lib/<abi>/` where `<ldName>.real`
    // does not exist; the fallback `_real.so` JNI sibling fixes that.
    // `libsigsys-handler.so` follows the same logic — same dirname,
    // unchanged basename so the wrapper's existing `<dir>/libsigsys-handler.so`
    // heuristic finds it.
    const realLoaderSrc = path.join(abiAssetsDir, `${ldName}.real`);
    if (fs.existsSync(realLoaderSrc)) {
      jniSources.push([
        realLoaderSrc,
        path.join(abiJniDir, jniRealLoaderName(ldName)),
      ]);
    }
    const sigsysShimSrc = path.join(abiAssetsDir, "libsigsys-handler.so");
    if (fs.existsSync(sigsysShimSrc)) {
      jniSources.push([
        sigsysShimSrc,
        path.join(abiJniDir, "libsigsys-handler.so"),
      ]);
    }
    for (const [src, dst] of jniSources) {
      if (copyIfDifferent(src, dst)) abiChanges += 1;
    }

    stagedCount += abiChanges;
    tlog(
      `Staged ${sources.length} runtime file(s) for ABI ${androidAbi}` +
        (abiChanges === 0 ? " (cached)" : ` (${abiChanges} updated)`),
    );
  }

  // ABI-independent assets: agent-bundle.js + PGlite payload, falling back
  // to the spike's tiny stub if Phase D hasn't been built yet. Phase D
  // produces a 33 MB real bundle in packages/agent/dist-mobile/ via
  // `bun run --cwd packages/agent build:mobile`. PGlite at runtime
  // resolves vector.tar.gz and fuzzystrmatch.tar.gz with `new URL("../X",
  // import.meta.url)`, so those two files must land ONE DIR ABOVE the
  // bundle on the device — ElizaAgentService extracts them into the
  // agent root (../) while the bundle itself sits in agent root (./).
  // Mirror that by staging vector + fuzzystrmatch in the assets tree at
  // the same level as agent-bundle.js, leaving relative resolution alone.
  //
  // The agent bundle is produced by `bun run --cwd packages/agent build:mobile`
  // and always lands in `<eliza-root>/packages/agent/dist-mobile/`. Resolve
  // it relative to THIS script's location (eliza/packages/app-core/scripts/lib/)
  // — that's a stable layout invariant. Resolving relative to spikeDir or
  // process.cwd() breaks when the eliza package is nested as a submodule
  // under a consumer/white-label repo, because their `scripts/` and
  // `packages/` directories live one level OUT from the eliza checkout.
  //
  // The legacy fallback to `<repoRoot>/packages/agent/dist-mobile/` is kept
  // for the standalone-eliza-monorepo build path where this same script
  // also runs and the bundle sits at the consumer-repo root.
  const elizaPackagesAgentDistMobile = path.resolve(
    __dirname,
    "..", // scripts/
    "..", // app-core/
    "..", // packages/
    "agent",
    "dist-mobile",
  );
  const consumerPackagesAgentDistMobile = path.resolve(
    path.dirname(spikeDir),
    "..",
    "packages",
    "agent",
    "dist-mobile",
  );
  const distMobileCandidates = [
    elizaPackagesAgentDistMobile,
    consumerPackagesAgentDistMobile,
  ];
  let distMobileDir = null;
  let distBundle = null;
  for (const candidate of distMobileCandidates) {
    const bundle = path.join(candidate, "agent-bundle.js");
    if (fs.existsSync(bundle)) {
      distMobileDir = candidate;
      distBundle = bundle;
      break;
    }
  }
  if (!distBundle) {
    distMobileDir = elizaPackagesAgentDistMobile;
    distBundle = path.join(distMobileDir, "agent-bundle.js");
  }
  const spikeServerJs = path.join(spikeDir, "server.js");

  let bundleSrc;
  if (fs.existsSync(distBundle)) {
    bundleSrc = distBundle;
    tlog(
      `Using Phase D agent bundle (${(fs.statSync(distBundle).size / (1024 * 1024)).toFixed(1)} MB)`,
    );
  } else if (fs.existsSync(spikeServerJs)) {
    bundleSrc = spikeServerJs;
    tlog(
      "Using spike placeholder agent-bundle.js — run `bun run --cwd " +
        "packages/agent build:mobile` to ship the real agent.",
    );
  } else {
    throw new Error(
      `No agent bundle source found. Tried: ${distBundle}, ${spikeServerJs}.`,
    );
  }
  const bundleTarget = path.join(assetsAgentDir, "agent-bundle.js");
  if (copyIfDifferent(bundleSrc, bundleTarget)) stagedCount += 1;

  // PGlite runtime artifacts. Only present when Phase D's build has run.
  // Skip silently when missing so the spike-bundle path still works.
  const pgliteAssets = [
    "pglite.wasm",
    "initdb.wasm",
    "pglite.data",
    "vector.tar.gz",
    "fuzzystrmatch.tar.gz",
    "plugins-manifest.json",
  ];
  for (const name of pgliteAssets) {
    const src = path.join(distMobileDir, name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(assetsAgentDir, name);
    if (copyIfDifferent(src, dst)) stagedCount += 1;
  }

  const launchTarget = path.join(assetsAgentDir, "launch.sh");
  if (writeIfChanged(launchTarget, LAUNCH_SCRIPT)) stagedCount += 1;

  tlog(
    `Staged on-device agent runtime in ${path.relative(androidDir, assetsAgentDir)} ` +
      `(${stagedCount} file change${stagedCount === 1 ? "" : "s"} this run).`,
  );

  return { assetsAgentDir, stagedCount };
}

export const __testables = {
  BUN_VERSION,
  ALPINE_BRANCH,
  ABI_TARGETS,
  APK_PACKAGES,
  LAUNCH_SCRIPT,
};
