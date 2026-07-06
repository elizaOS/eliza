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
 *   agent-bundle.js                 (ABI-independent @elizaos/agent bundle)
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
 *   riscv64/bun                     (cuttlefish riscv64; required unless
 *                                    ELIZA_BUN_RISCV64_OPTIONAL=1 since
 *                                    upstream Bun has no riscv64-linux-musl
 *                                    release)
 *   riscv64/ld-musl-riscv64.so.1
 *   riscv64/libstdc++.so.6.0.33
 *   riscv64/libgcc_s.so.1
 *
 * Downloads are cached under `~/.cache/eliza-android-agent/<bun-version>/`
 * and the staging step is idempotent — already-staged files with matching
 * bytes are left in place.
 *
 * Pinned versions:
 *   - bun 1.3.14                     validated by Android agent bring-up
 *   - Alpine v3.21                   ships gcc 14.2 → libstdc++.so.6.0.33
 *
 * The ABI-independent `launch.sh` is the packaged production launcher;
 * `agent-bundle.js` is produced by `bun run --cwd packages/agent build:mobile`.
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_CORE_ROOT = path.resolve(__dirname, "..", "..");
const ELIZA_REPO_ROOT = path.resolve(APP_CORE_ROOT, "..", "..");
const CLEANUP_HELPER_SCRIPT = path.join(
  ELIZA_REPO_ROOT,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

const BUN_VERSION = "1.3.14";
// Bun 1.3.13 had a segfault during inference on Cuttlefish at peak
// ~2.3 GB RSS ("panic(main thread): Segmentation fault at address 0x5420").
// 1.3.14 (released 2026-05-13) is the stable release that supersedes the
// canary stopgap we used while waiting for it. The canary channel remains
// the default below for AOSP/CVD builds via run-mobile-build; stock APK
// builds use this stable pin unless explicitly overridden.
const DEFAULT_BUN_CHANNEL = "canary";
const ALPINE_BRANCH = "v3.21";
const RISCV64_BUN_ARTIFACT_FILENAME = "bun-linux-riscv64-musl.zip";
export const RUNTIME_PROVENANCE_FILENAME =
  "android-agent-runtime-provenance.json";

/**
 * Default cache dir for compile-shim.mjs's outputs. Mirrors the default
 * in `packages/app-core/scripts/aosp/compile-shim.mjs`. We resolve from
 * `os.homedir()` directly instead of importing `compile-shim.mjs` to
 * avoid pulling the zig probe + shell-out machinery into the staging
 * step (this module runs unconditionally on every gradle build, not
 * just AOSP).
 */
const SECCOMP_SHIM_CACHE_DIR = path.join(
  os.homedir(),
  ".cache",
  "eliza-android-agent",
  "seccomp-shim",
);

const ZIG_VERSION = "0.13.0";
const ZIG_TOOLCHAINS = {
  "linux/x64": {
    dirName: "zig-linux-x86_64-0.13.0",
    sha256: "d45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea",
  },
  "linux/arm64": {
    dirName: "zig-linux-aarch64-0.13.0",
    sha256: "041ac42323837eb5624068acd8b00cd5777dac4cf91179e8dad7a7e90dd0c556",
  },
  "darwin/x64": {
    dirName: "zig-macos-x86_64-0.13.0",
    sha256: "8b06ed1091b2269b700b3b07f8e3be3b833000841bae5aa6a09b1a8b4773effd",
  },
  "darwin/arm64": {
    dirName: "zig-macos-aarch64-0.13.0",
    sha256: "46fae219656545dfaf4dce12fb4e8685cec5b51d721beee9389ab4194d43394c",
  },
};

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
  {
    // Upstream Bun has no riscv64-linux-musl release as of this writing,
    // so this ABI only succeeds when `ELIZA_BUN_RISCV64_FILE` or
    // `ELIZA_BUN_RISCV64_URL` points at a self-built canary zip produced
    // by `packages/app-core/scripts/bun-riscv64/build.sh`. Objective AOSP
    // builds fail closed by default; local native-library iteration can
    // opt out with ELIZA_BUN_RISCV64_OPTIONAL=1.
    androidAbi: "riscv64",
    bunArch: "riscv64",
    alpineArch: "riscv64",
    ldName: "ld-musl-riscv64.so.1",
  },
];

const NATIVE_LLAMA_ASSET_ENV_KEYS = [
  "ELIZA_ANDROID_AGENT_NATIVE_ASSET_DIR",
  "ELIZA_AOSP_LLAMA_ASSET_DIR",
  "ELIZA_MTP_ANDROID_LIBDIR",
];

const APK_PACKAGES = [
  { pkg: "musl", file: "musl.apk" },
  { pkg: "libstdc++", file: "libstdcxx.apk" },
  { pkg: "libgcc", file: "libgcc.apk" },
];

const LLAMA_KERNEL_DIAGNOSTIC_SCRIPT = `#!/usr/bin/env bun
/**
 * Model-free llama.cpp kernel capability diagnostic for ElizaOS Android.
 *
 * This does not load a model or claim inference throughput. It verifies that
 * the ABI-local llama.cpp payload advertises the kernel families expected by
 * the E1/AOSP path, and optionally checks llama-server --help for CLI surface.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REQUIRED_KERNELS = ["mtp", "turbo3", "turbo4", "turbo3_tcq", "qjl_full", "polarquant"];
const REQUIRED_HELP_NEEDLES = ["--spec-type", "mtp", "tbq3_0", "tbq4_0", "qjl1_256", "q4_polar"];
const REQUIRED_FILES = [
  "CAPABILITIES.json",
  "libllama.so",
  "libggml.so",
  "libeliza-llama-shim.so",
  "libeliza-llama-speculative-shim.so",
  "llama-server",
];

function hasKernel(capabilities, name) {
  const kernels = capabilities.kernels ?? capabilities.kernel_features ?? {};
  if (Array.isArray(kernels)) return kernels.includes(name);
  if (typeof kernels === "object" && kernels !== null) {
    const value = kernels[name];
    if (value === true) return true;
    if (typeof value === "object" && value !== null) {
      return value.enabled === true || value.publishable === true;
    }
  }
  return capabilities[name] === true;
}

const abiDir = path.resolve(process.argv[2] ?? process.cwd());
const staticOnly = process.argv.includes("--static-only");
const missingFiles = REQUIRED_FILES.filter((name) => !fs.existsSync(path.join(abiDir, name)));
const capabilitiesPath = path.join(abiDir, "CAPABILITIES.json");
let capabilities = {};
if (fs.existsSync(capabilitiesPath)) {
  capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, "utf8"));
}
const missingKernels = REQUIRED_KERNELS.filter((name) => !hasKernel(capabilities, name));
const publishable = capabilities.publishable === true || capabilities.release_status === "publishable";

let helpStatus = null;
let missingHelpNeedles = [];
if (!staticOnly && fs.existsSync(path.join(abiDir, "llama-server"))) {
  const result = spawnSync(path.join(abiDir, "llama-server"), ["--help"], {
    cwd: abiDir,
    encoding: "utf8",
  });
  const text = (result.stdout ?? "") + "\\n" + (result.stderr ?? "");
  helpStatus = result.status;
  missingHelpNeedles = REQUIRED_HELP_NEEDLES.filter((needle) => !text.includes(needle));
}

const ok =
  missingFiles.length === 0 &&
  missingKernels.length === 0 &&
  publishable &&
  (staticOnly || (helpStatus === 0 && missingHelpNeedles.length === 0));

console.log(JSON.stringify({
  schema: "eliza.android_llama_kernel_diagnostic.v1",
  claim_boundary: "model_free_llama_cpp_kernel_capability_check_only_not_model_inference_or_performance_evidence",
  abi_dir: abiDir,
  ok,
  publishable,
  static_only: staticOnly,
  required_files: REQUIRED_FILES,
  missing_files: missingFiles,
  required_kernels: REQUIRED_KERNELS,
  missing_kernels: missingKernels,
  llama_server_help_status: helpStatus,
  missing_help_needles: missingHelpNeedles,
}, null, 2));
process.exit(ok ? 0 : 1);
`;

function jniLoaderName(ldName) {
  if (ldName.includes("aarch64")) return "libeliza_ld_musl_aarch64.so";
  if (ldName.includes("x86_64")) return "libeliza_ld_musl_x86_64.so";
  if (ldName.includes("riscv64")) return "libeliza_ld_musl_riscv64.so";
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
 * The script ships *inside* the APK and is copied (with executable bit set)
 * into the app data dir by ElizaAgentService at first launch. It accepts the
 * device path, ABI-specific musl loader, and listen port as env vars so a
 * single shell file can drive both ABIs at runtime.
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
#   DEVICE_DIR  Absolute path on the device that holds bun + musl.
#   LD_NAME     Per-ABI musl loader filename (ld-musl-{x86_64,aarch64}.so.1).
#
# Optional:
#   PORT        Loopback port for the HTTP listener. Unset by default — the agent
#               is port-free (requests ride the abstract UDS); ElizaAgentService
#               only exports PORT when ELIZA_API_EXPOSE_PORT re-opens the port.
#   AGENT_ROOT         Directory that holds agent-bundle.js; defaults DEVICE_DIR.
#   RUNTIME_DIR        Directory that holds bun + runtime libs; defaults DEVICE_DIR.
#   BUN_PATH           Absolute bun executable path; defaults RUNTIME_DIR/bun.
#   LD_PATH            Absolute musl-loader path; defaults RUNTIME_DIR/LD_NAME.
#   AGENT_BUNDLE       Bundle filename; defaults agent-bundle.js.
#   AGENT_BUNDLE_PATH  Absolute bundle path; defaults AGENT_ROOT/AGENT_BUNDLE.
#   AGENT_COMMAND      Optional agent CLI command, e.g. android-bridge.
#   LOG_FILE           Defaults to agent.log in AGENT_ROOT.
#   DIAGNOSTICS_FILE   JSONL restart diagnostics path; defaults beside agent.log.
#   ELIZA_STARTUP_TRACE_ID  Per-launch id mirrored into diagnostics.

DEVICE_DIR=\${DEVICE_DIR:-/data/local/tmp}
RUNTIME_DIR=\${RUNTIME_DIR:-\${DEVICE_DIR}}
AGENT_ROOT=\${AGENT_ROOT:-\${DEVICE_DIR}}
LD_NAME=\${LD_NAME:-ld-musl-x86_64.so.1}
AGENT_BUNDLE=\${AGENT_BUNDLE:-agent-bundle.js}
BUN_PATH=\${BUN_PATH:-\${RUNTIME_DIR}/bun}
LD_PATH=\${LD_PATH:-\${RUNTIME_DIR}/\${LD_NAME}}
AGENT_BUNDLE_PATH=\${AGENT_BUNDLE_PATH:-\${AGENT_ROOT}/\${AGENT_BUNDLE}}
AGENT_COMMAND=\${AGENT_COMMAND:-}
LOG_FILE=\${LOG_FILE:-\${AGENT_ROOT}/agent.log}
DIAGNOSTICS_FILE=\${DIAGNOSTICS_FILE:-\${AGENT_ROOT}/agent-restart-diagnostics.jsonl}
STARTUP_TRACE_ID=\${ELIZA_STARTUP_TRACE_ID:-}
RUNTIME_LD_LIBRARY_PATH=\${LD_LIBRARY_PATH:-\${RUNTIME_DIR}}

cd "$AGENT_ROOT" || exit 1
pkill -f "\${BUN_PATH}" 2>/dev/null
pkill -f "\${AGENT_BUNDLE_PATH}" 2>/dev/null
sleep 1

if [ -n "\${AGENT_COMMAND}" ]; then
  set -- "\${LD_PATH}" "\${BUN_PATH}" "\${AGENT_BUNDLE_PATH}" "\${AGENT_COMMAND}"
else
  set -- "\${LD_PATH}" "\${BUN_PATH}" "\${AGENT_BUNDLE_PATH}"
fi

(
  setsid sh "\${AGENT_ROOT}/launch-child.sh" "\${LOG_FILE}" "\${AGENT_ROOT}" "\${RUNTIME_LD_LIBRARY_PATH}" "\${PORT:-}" "\${DIAGNOSTICS_FILE}" "\${STARTUP_TRACE_ID}" "$@" &
) &
disown 2>/dev/null || true
exit 0
`;

/**
 * Detached-child half of launch.sh's double-fork, shipped as its OWN file.
 *
 * This logic used to be inlined as a multi-line \`sh -c '...'\` string inside
 * launch.sh. That is a runtime trap: the script body contains single-quoted
 * printf formats AND brace groups with commas ({"childPid":"%s",...}), so the
 * quoting fuses into an unquoted segment that Android's mksh BRACE-EXPANDS
 * into multiple words — the -c script truncates mid-body and mksh execs the
 * leftover tail as a filename. The detached agent then never spawns, silently
 * (launcher stdio is /dev/null). Desktop shells don't brace-expand unquoted
 * words, so sh -n and laptop runs never catch it; the breakage is
 * device-only. A standalone file has no nested-quoting layer at all.
 */
const LAUNCH_CHILD_SCRIPT = `#!/system/bin/sh
# launch-child.sh — detached child half of launch.sh's setsid double-fork.
# Invoked as: sh launch-child.sh LOG_FILE AGENT_ROOT RUNTIME_LD PORT \\
#             DIAGNOSTICS_FILE STARTUP_TRACE_ID <argv...>
# Redirects stdio, spawns the agent argv, and journals child start/exit into
# the restart-diagnostics JSONL so a dead spawn is visible from adb run-as.
log_file=$1; agent_root=$2; runtime_ld=$3; port=$4; diagnostics_file=$5; startup_trace_id=$6; shift 6
append_diag() {
  event=$1
  child_pid=$2
  exit_code=$3
  ts="$(date +%s 2>/dev/null || echo 0)000"
  printf '{"ts":%s,"event":"%s","status":"launcher-child","detachedAgentMode":true,"restartAttempts":-1,"details":{"childPid":"%s","exitCode":"%s","startupTraceId":"%s"}}\\n' "$ts" "$event" "$child_pid" "$exit_code" "$startup_trace_id" >> "$diagnostics_file" 2>/dev/null || true
}
exec </dev/null >"$log_file" 2>&1
cd "$agent_root" || exit 1
if [ -n "$port" ]; then export PORT="$port"; fi
LD_LIBRARY_PATH="$runtime_ld" "$@" &
agent_pid=$!
append_diag "agent-child-started" "$agent_pid" ""
wait "$agent_pid"
status=$?
append_diag "agent-child-exited" "$agent_pid" "$status"
exit "$status"
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

function removePathRecursiveSync(targetPath) {
  execFileSync(process.execPath, [CLEANUP_HELPER_SCRIPT, targetPath], {
    cwd: ELIZA_REPO_ROOT,
    stdio: "ignore",
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

function normalizeSha256(value, envName) {
  const sha256 = value?.trim().toLowerCase();
  if (!sha256) return null;
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(
      `${envName} must be a lowercase or uppercase 64-character SHA-256 hex digest.`,
    );
  }
  return sha256;
}

function firstEnvValue(names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

function riscv64BunSha256() {
  const configured = firstEnvValue(["ELIZA_BUN_RISCV64_SHA256"]);
  return normalizeSha256(
    configured?.value,
    configured?.name ?? "ELIZA_BUN_RISCV64_SHA256",
  );
}

function defaultRiscv64BunArtifactPath() {
  return path.resolve(
    __dirname,
    "..",
    "bun-riscv64",
    "dist",
    RISCV64_BUN_ARTIFACT_FILENAME,
  );
}

function riscv64BunFilePath() {
  const configured = firstEnvValue(["ELIZA_BUN_RISCV64_FILE"]);
  if (configured) return path.resolve(configured.value);
  const defaultPath = defaultRiscv64BunArtifactPath();
  return fs.existsSync(defaultPath) ? defaultPath : null;
}

function riscv64BunUrl() {
  return firstEnvValue(["ELIZA_BUN_RISCV64_URL"])?.value ?? null;
}

function riscv64BunArtifactSource() {
  const filePath = riscv64BunFilePath();
  if (filePath) return { kind: "file", ...provenancePath(filePath) };
  const url = riscv64BunUrl();
  if (url) return { kind: "url", url };
  return null;
}

function resolveZigToolchain() {
  return ZIG_TOOLCHAINS[`${process.platform}/${process.arch}`] ?? null;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}

function pathWithin(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? toPosixPath(relative)
    : null;
}

function provenancePath(filePath) {
  const absolute = path.resolve(filePath);
  const repoRelative = pathWithin(ELIZA_REPO_ROOT, absolute);
  if (repoRelative) {
    return {
      path: repoRelative,
      path_provenance: "relative_to_git_checkout",
    };
  }
  const appCoreRelative = pathWithin(APP_CORE_ROOT, absolute);
  if (appCoreRelative) {
    return {
      path: appCoreRelative,
      path_provenance: "relative_to_app_core",
    };
  }
  return {
    path: path.basename(absolute),
    path_provenance: "external_artifact_basename",
  };
}

function normalizeSourceForProvenance(value) {
  if (Array.isArray(value)) return value.map(normalizeSourceForProvenance);
  if (!value || typeof value !== "object") return value;
  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      path.isAbsolute(child) &&
      (key === "path" || key.endsWith("_path"))
    ) {
      Object.assign(normalized, provenancePath(child));
    } else if (
      typeof child === "string" &&
      path.isAbsolute(child) &&
      (key === "cache_dir" || key.endsWith("_dir"))
    ) {
      normalized[key] = path.basename(child);
      normalized[`${key}_provenance`] = "external_cache_dir_basename";
    } else {
      normalized[key] = normalizeSourceForProvenance(child);
    }
  }
  return normalized;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fileProvenanceEntry({ filePath, relativePath, source }) {
  const stat = fs.statSync(filePath);
  return {
    path: androidApkEntryPath(relativePath),
    size_bytes: stat.size,
    sha256: sha256File(filePath),
    source: normalizeSourceForProvenance(source),
  };
}

function androidApkEntryPath(relativePath) {
  const entryPath = toPosixPath(relativePath);
  return entryPath.replace(/^jniLibs\//, "lib/");
}

function normalizeBunChannel(value) {
  const channel = String(value ?? DEFAULT_BUN_CHANNEL)
    .trim()
    .toLowerCase();
  if (channel === "stable" || channel === "release") return "stable";
  if (channel === "canary") return "canary";
  throw new Error(
    `Unsupported ELIZA_BUN_CHANNEL=${JSON.stringify(value)}. ` +
      "Expected stable or canary.",
  );
}

function resolveBunChannel(preferredChannel) {
  return normalizeBunChannel(
    process.env.ELIZA_BUN_CHANNEL ?? preferredChannel ?? DEFAULT_BUN_CHANNEL,
  );
}

function bunCacheKey(channel) {
  return channel === "canary" ? "canary" : BUN_VERSION;
}

function bunChannelLabel(channel) {
  return channel === "canary" ? "bun-canary" : `bun-${BUN_VERSION}`;
}

function defaultBunCacheDir(channel) {
  return path.join(
    os.homedir(),
    ".cache",
    "eliza-android-agent",
    `bun-${bunCacheKey(channel)}`,
  );
}

async function ensureBunBinary({ cacheDir, bunArch, bunChannel, log }) {
  const channelTag = bunChannel === "canary" ? "canary" : `bun-v${BUN_VERSION}`;
  const cacheKey = bunCacheKey(bunChannel);
  const archCache = path.join(cacheDir, `bun-${bunArch}-${cacheKey}`);
  const bunPath = path.join(archCache, "bun");
  const sourceSha256Path = path.join(archCache, ".source.sha256");
  const expectedRiscv64Sha256 =
    bunArch === "riscv64" ? riscv64BunSha256() : null;
  // Canary cache invalidates after 24h so we pull bug-fix snapshots
  // automatically without forcing every CI run to re-download.
  const isFresh = (() => {
    if (!fs.existsSync(bunPath)) return false;
    const st = fs.statSync(bunPath);
    if (st.size <= 1_000_000) return false;
    if (bunArch === "riscv64") {
      if (!expectedRiscv64Sha256) return false;
      if (!fs.existsSync(sourceSha256Path)) return false;
      const cachedSha256 = fs
        .readFileSync(sourceSha256Path, "utf8")
        .trim()
        .toLowerCase();
      if (cachedSha256 !== expectedRiscv64Sha256) return false;
    }
    if (bunChannel !== "canary") return true;
    const ageMs = Date.now() - st.mtimeMs;
    return ageMs < 24 * 60 * 60 * 1000;
  })();
  if (isFresh) {
    return {
      bunPath,
      source: {
        kind: "cache",
        cache_key: path.basename(archCache),
        artifact_sha256: expectedRiscv64Sha256,
      },
    };
  }
  fs.mkdirSync(archCache, { recursive: true });
  const zipPath = path.join(archCache, "bun.zip");
  // riscv64 has no upstream Bun release. Allow operators to point at a
  // self-built canary artifact via a local file or URL; otherwise refuse to
  // download from a guessed URL and surface a clear pointer at the cross-build
  // pipeline. We never invent a default URL.
  let url;
  let sourceFile;
  if (bunArch === "riscv64") {
    sourceFile = riscv64BunFilePath();
    url = riscv64BunUrl();
    if (!sourceFile && !url) {
      throw new Error(
        "Bun riscv64 artifact not available: upstream Bun has no riscv64-linux-musl release. " +
          "Set ELIZA_BUN_RISCV64_FILE to a local " +
          "self-built zip, or set ELIZA_BUN_RISCV64_URL " +
          "to a hosted zip produced by packages/app-core/scripts/bun-riscv64/build.sh, " +
          "or set ELIZA_BUN_RISCV64_OPTIONAL=1 for local non-objective builds.",
      );
    }
    if (!expectedRiscv64Sha256) {
      throw new Error(
        "Bun riscv64 artifact hash is required: set ELIZA_BUN_RISCV64_SHA256 " +
          "to the SHA-256 of bun-linux-riscv64-musl.zip.",
      );
    }
  } else {
    url =
      bunChannel === "canary"
        ? `https://github.com/oven-sh/bun/releases/download/canary/bun-linux-${bunArch}-musl.zip`
        : `https://github.com/oven-sh/bun/releases/download/${channelTag}/bun-linux-${bunArch}-musl.zip`;
  }
  const channelLabel = bunChannelLabel(bunChannel);
  if (sourceFile) {
    if (!fs.existsSync(sourceFile)) {
      throw new Error(`Bun riscv64 artifact file not found: ${sourceFile}`);
    }
    log(
      `Using local ${channelLabel} (${bunArch}-musl) artifact at ${sourceFile}`,
    );
    fs.copyFileSync(sourceFile, zipPath);
  } else {
    log(`Downloading ${channelLabel} (${bunArch}-musl) from ${url}`);
    await downloadFile(url, zipPath);
  }
  if (expectedRiscv64Sha256) {
    const actualSha256 = sha256File(zipPath);
    if (actualSha256 !== expectedRiscv64Sha256) {
      fs.rmSync(zipPath, { force: true });
      throw new Error(
        `bun-linux-riscv64-musl.zip SHA-256 mismatch: expected ` +
          `${expectedRiscv64Sha256}, got ${actualSha256}`,
      );
    }
  }
  await run("unzip", ["-q", "-o", zipPath, "-d", archCache]);
  const extractedDir = path.join(archCache, `bun-linux-${bunArch}-musl`);
  const extractedBun = path.join(extractedDir, "bun");
  if (!fs.existsSync(extractedBun)) {
    throw new Error(`bun zip did not contain bun at ${extractedBun}`);
  }
  if (fs.existsSync(bunPath)) fs.unlinkSync(bunPath);
  fs.renameSync(extractedBun, bunPath);
  removePathRecursiveSync(extractedDir);
  fs.rmSync(zipPath, { force: true });
  fs.chmodSync(bunPath, 0o755);
  if (expectedRiscv64Sha256) {
    fs.writeFileSync(sourceSha256Path, `${expectedRiscv64Sha256}\n`, "utf8");
  }
  return {
    bunPath,
    source: {
      kind: sourceFile ? "file" : "url",
      ...(sourceFile ? provenancePath(sourceFile) : {}),
      url: sourceFile ? null : url,
      artifact_filename:
        bunArch === "riscv64"
          ? RISCV64_BUN_ARTIFACT_FILENAME
          : path.basename(url),
      artifact_sha256: expectedRiscv64Sha256,
    },
  };
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
  removePathRecursiveSync(extractDir);
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
    if (a.size === b.size) {
      const sameBytes = fs.readFileSync(source).equals(fs.readFileSync(target));
      if (sameBytes) return false;
    }
  }
  fs.copyFileSync(source, target);
  return true;
}

function resolveNativeLlamaAssetDir(androidAbi) {
  // Look up an env-var-supplied prebuilt native llama asset dir for this
  // ABI. Each env var may be either:
  //   - a single absolute dir (legacy arm64-only contract — the prebuilt
  //     lives directly inside; only honoured when androidAbi is arm64-v8a),
  //   - a per-ABI suffixed variant `<KEY>_<ABI>` where ABI is the upper-
  //     snake-cased androidAbi (e.g. ELIZA_AOSP_LLAMA_ASSET_DIR_ARM64_V8A,
  //     _X86_64, _RISCV64),
  //   - or a base dir that contains per-ABI subdirectories named after the
  //     androidAbi (e.g. `<dir>/arm64-v8a/`, `<dir>/x86_64/`, `<dir>/riscv64/`).
  // The first env key that resolves to a real dir for this ABI wins. We
  // never fall back across ABIs (an arm64 prebuilt is not valid for x86_64
  // or riscv64).
  const abiSuffix = androidAbi.replace(/-/g, "_").toUpperCase();
  for (const key of NATIVE_LLAMA_ASSET_ENV_KEYS) {
    // 1. Per-ABI env var wins outright.
    const perAbiRaw = process.env[`${key}_${abiSuffix}`]?.trim();
    if (perAbiRaw) {
      const resolved = path.resolve(perAbiRaw);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return { dir: resolved, key: `${key}_${abiSuffix}` };
      }
    }
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    const baseResolved = path.resolve(raw);
    if (!fs.existsSync(baseResolved)) continue;
    if (!fs.statSync(baseResolved).isDirectory()) continue;
    // 2. Base dir containing per-ABI subdirs.
    const perAbiSubdir = path.join(baseResolved, androidAbi);
    if (
      fs.existsSync(perAbiSubdir) &&
      fs.statSync(perAbiSubdir).isDirectory()
    ) {
      return { dir: perAbiSubdir, key: `${key}/${androidAbi}` };
    }
    // 3. Legacy: the env var points directly at the prebuilt dir; honour
    //    it only for arm64-v8a since that's the only ABI the legacy
    //    contract ever shipped a prebuilt for.
    if (androidAbi === "arm64-v8a") {
      return { dir: baseResolved, key };
    }
  }
  return null;
}

function shouldStageNativeLlamaAsset(name) {
  return (
    /^lib(?:llama|llama-common|ggml|mtmd|eliza-llama|elizainference).*(?:\.so|\.so\.\d.*)$/.test(
      name,
    ) ||
    /^libomnivoice(?:\.so|\.so\.\d.*)$/.test(name) ||
    name === "llama-server" ||
    name === "llama-omnivoice-server" ||
    name === "CAPABILITIES.json" ||
    name === "OMNIVOICE_FUSE_VERIFY.json"
  );
}

function stageNativeLlamaAssetsForAbi({ androidAbi, abiAssetsDir, log }) {
  const source = resolveNativeLlamaAssetDir(androidAbi);
  if (!source) return 0;

  let changes = 0;
  let copied = 0;
  for (const entry of fs.readdirSync(source.dir, { withFileTypes: true })) {
    if (!entry.isFile() || !shouldStageNativeLlamaAsset(entry.name)) continue;
    const src = path.join(source.dir, entry.name);
    const dst = path.join(abiAssetsDir, entry.name);
    if (copyIfDifferent(src, dst)) changes += 1;
    if (
      entry.name === "llama-server" ||
      entry.name === "llama-omnivoice-server"
    ) {
      fs.chmodSync(dst, fs.statSync(dst).mode | 0o755);
    }
    copied += 1;
  }

  // The fused libelizainference.so is the activation lib (ElizaAgentService
  // gates ELIZA_LOCAL_LLAMA on it). As of the static-fuse build recipe
  // (BUILD_SHARED_LIBS=OFF + CMAKE_POSITION_INDEPENDENT_CODE=ON in
  // build-helpers/omnivoice-merged.mjs fusedExtraCmakeFlags + the bionic JNI
  // builder) it is SELF-CONTAINED: llama/ggml/mtmd are folded in as static
  // archives, so its only DT_NEEDED entries are libc/libm/libdl — there is no
  // runtime libllama.so / libggml*.so sibling to resolve via LD_LIBRARY_PATH.
  // So only libelizainference.so is required. A non-fused bulk build may still
  // emit libllama.so + the libggml* family as a byproduct; if present they
  // stage harmlessly via shouldStageNativeLlamaAsset() above, but they are no
  // longer a hard requirement for the fused activation path. The
  // eliza-llama-shim was retired with the libllama TS adapter.
  const required = ["libelizainference.so"];
  const missing = required.filter(
    (name) => !fs.existsSync(path.join(abiAssetsDir, name)),
  );
  if (missing.length > 0) {
    log(
      `Native llama asset dir from ${source.key} did not provide ${missing.join(", ")}; ` +
        `ELIZA_LOCAL_LLAMA will remain disabled for ${androidAbi}.`,
    );
  } else {
    log(
      `Staged ${copied} native llama asset file(s) for ${androidAbi} from ${source.key}` +
        (changes > 0 ? ` (${changes} updated)` : " (already current)"),
    );
  }
  return changes;
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
 * happened). When no compiled shim exists for an ABI that stock Android
 * requires, fail the build instead of shipping a known-SIGSYS-dead runtime.
 *
 * Exported for testing.
 */
/**
 * Best-effort auto-provision of the compiled SIGSYS shim: download the pinned
 * zig 0.13.0 toolchain into the eliza cache (same auto-download pattern this
 * script already uses for bun + the Alpine loader set) and run
 * compile-shim.mjs for the ABI. Returns true when the shim cache exists
 * afterwards. Failures return false — the caller decides whether that is
 * fatal (stock-Android app builds) or tolerated (explicit opt-out).
 */
export function autoProvisionSeccompShim({
  androidAbi,
  cacheDir = SECCOMP_SHIM_CACHE_DIR,
  log,
}) {
  // Operator/test escape: never download or compile (air-gapped builders,
  // hermetic tests). The missing-shim hard error downstream still applies.
  if (process.env.ELIZA_SECCOMP_SHIM_NO_AUTOPROVISION === "1") {
    return false;
  }
  const abiCacheDir = path.join(cacheDir, androidAbi);
  if (fs.existsSync(path.join(abiCacheDir, "libsigsys-handler.so"))) {
    return true;
  }
  const zigToolchain = resolveZigToolchain();
  if (!zigToolchain) {
    log?.(
      `Cannot auto-provision the SIGSYS shim on ${process.platform}/${process.arch}; ` +
        `no pinned zig ${ZIG_VERSION} build for this host.`,
    );
    return false;
  }
  const zigCacheRoot = path.join(
    os.homedir(),
    ".cache",
    "eliza-android-agent",
    "zig",
  );
  const zigBin = path.join(zigCacheRoot, zigToolchain.dirName, "zig");
  try {
    if (!fs.existsSync(zigBin)) {
      fs.mkdirSync(zigCacheRoot, { recursive: true });
      const tarball = path.join(zigCacheRoot, `${zigToolchain.dirName}.tar.xz`);
      const url = `https://ziglang.org/download/${ZIG_VERSION}/${zigToolchain.dirName}.tar.xz`;
      log?.(
        `Downloading pinned zig ${ZIG_VERSION} for the SIGSYS shim: ${url}`,
      );
      execFileSync("curl", ["-fsSL", "-o", tarball, url], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      const actualSha256 = sha256File(tarball);
      if (actualSha256 !== zigToolchain.sha256) {
        fs.rmSync(tarball, { force: true });
        throw new Error(
          `zig ${ZIG_VERSION} tarball SHA-256 mismatch: expected ` +
            `${zigToolchain.sha256}, got ${actualSha256}`,
        );
      }
      execFileSync("tar", ["xJf", tarball, "-C", zigCacheRoot], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      fs.rmSync(tarball, { force: true });
    }
    const compileShim = path.join(
      APP_CORE_ROOT,
      "scripts",
      "aosp",
      "compile-shim.mjs",
    );
    log?.(
      `Compiling SIGSYS shim for ${androidAbi} with pinned zig ${ZIG_VERSION}.`,
    );
    execFileSync(
      process.execPath,
      [
        compileShim,
        "--abi",
        androidAbi,
        "--cache-dir",
        cacheDir,
        "--skip-if-present",
      ],
      {
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          ...process.env,
          PATH: `${path.dirname(zigBin)}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
  } catch (error) {
    log?.(
      `SIGSYS shim auto-provision failed for ${androidAbi}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  return fs.existsSync(path.join(abiCacheDir, "libsigsys-handler.so"));
}

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
    // Provision in place before refusing: pinned-zig download + compile-shim,
    // the same self-sufficiency this script's bun/Alpine downloads already
    // have, so fresh hosts and CI runners build device-valid APKs without a
    // manual toolchain step.
    autoProvisionSeccompShim({ androidAbi, cacheDir, log });
  }
  if (!fs.existsSync(cachedWrap) || !fs.existsSync(cachedShim)) {
    throw new Error(
      `[stage-android-agent] Missing compiled SIGSYS shim for ${androidAbi}. ` +
        `Stock Android kills the raw Alpine loader with SIGSYS during Bun's ` +
        `event loop startup; refusing to build an APK that cannot boot. Run ` +
        `\`node packages/app-core/scripts/aosp/compile-shim.mjs --abi ${androidAbi}\` ` +
        `or restore ${path.relative(process.cwd(), abiCacheDir)} before building.`,
    );
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
 *   spikeDir    Absolute path to the Android-agent script directory. Kept
 *               for legacy workspace-root resolution; it is not used as a
 *               bundle fallback.
 *
 * Optional:
 *   cacheDir    Defaults to ~/.cache/eliza-android-agent/<bun-version>/.
 *   bunChannel  stable | canary. ELIZA_BUN_CHANNEL overrides this option.
 *   log         Defaults to console.log.
 */
export async function stageAndroidAgentRuntime({
  androidDir,
  spikeDir,
  cacheDir,
  bunChannel: preferredBunChannel,
  objective = false,
  log = console.log,
} = {}) {
  if (!androidDir)
    throw new Error("stageAndroidAgentRuntime: androidDir is required");
  if (!spikeDir)
    throw new Error("stageAndroidAgentRuntime: spikeDir is required");

  const tlog = logFor(log);
  const bunChannel = resolveBunChannel(preferredBunChannel);
  const resolvedCacheDir = cacheDir ?? defaultBunCacheDir(bunChannel);
  tlog(`Staging Android agent runtime with ${bunChannelLabel(bunChannel)}.`);
  fs.mkdirSync(resolvedCacheDir, { recursive: true });

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
  const stagedFiles = [];
  const riscv64Artifact = {
    required: objective,
    filename: RISCV64_BUN_ARTIFACT_FILENAME,
    sha256: riscv64BunSha256(),
    source: riscv64BunArtifactSource(),
  };

  for (const target of ABI_TARGETS) {
    const { androidAbi, bunArch, alpineArch, ldName } = target;
    // Objective builds fail closed on riscv64. Upstream Bun has no
    // riscv64-linux-musl release, so provide ELIZA_BUN_RISCV64_FILE or
    // ELIZA_BUN_RISCV64_URL from packages/app-core/scripts/bun-riscv64/build.sh.
    // Local native-library iteration may opt out with
    // ELIZA_BUN_RISCV64_OPTIONAL=1, but that build is not valid AOSP/chip
    // objective evidence.
    if (bunArch === "riscv64") {
      const riscvFile = riscv64BunFilePath();
      const riscvUrl = riscv64BunUrl();
      // riscv64 is fail-closed ONLY for objective AOSP/chip builds (they ship
      // riscv64 and must prove it). A stock arm64 phone build skips the slice
      // when no artifact is configured instead of aborting — upstream Bun has
      // no riscv64-linux-musl release, so a plain `build:android` would
      // otherwise demand a binary it never packages. ELIZA_BUN_RISCV64_OPTIONAL=1
      // still force-skips even for objective builds (native-lib iteration). A
      // genuine riscv64 build supplies ELIZA_BUN_RISCV64_FILE/_URL, so the slice
      // stages either way — the skip only fires when there is no artifact at all.
      const forceSkip = process.env.ELIZA_BUN_RISCV64_OPTIONAL === "1";
      if (!riscvFile && !riscvUrl && (!objective || forceSkip)) {
        tlog(
          `Skipping ABI ${androidAbi}: no ELIZA_BUN_RISCV64_FILE or URL is set ` +
            `(upstream Bun has no riscv64-linux-musl release). Build with ` +
            `packages/app-core/scripts/bun-riscv64/build.sh and re-run for AOSP/chip evidence.`,
        );
        continue;
      }
    }
    const abiAssetsDir = path.join(assetsAgentDir, androidAbi);
    const abiJniDir = path.join(jniLibsDir, androidAbi);
    fs.mkdirSync(abiAssetsDir, { recursive: true });
    fs.mkdirSync(abiJniDir, { recursive: true });

    const bun = await ensureBunBinary({
      cacheDir: resolvedCacheDir,
      bunArch,
      bunChannel,
      log: tlog,
    });
    const bunPath = bun.bunPath;
    const extractDir = await ensureAlpineApkExtracted({
      cacheDir: resolvedCacheDir,
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

    abiChanges += stageNativeLlamaAssetsForAbi({
      androidAbi,
      abiAssetsDir,
      log: tlog,
    });

    // llama-server is produced by compile-libllama.mjs (per-ABI). It already
    // lands at <abiAssetsDir>/llama-server when that script ran successfully,
    // so we don't re-copy here — but we do ensure the bit is +x because some
    // file-copy paths (e.g. zip → unzip on Windows builders) lose the
    // executable bit. The aosp-llama-adapter spawns it for MTP decode;
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
        `No llama-server staged for ${androidAbi}; MTP spec-decode on AOSP ` +
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
    // size+mtime check). If shim artifacts are missing we fail here rather
    // than shipping a stock Android APK whose local agent dies with SIGSYS.
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

    const stagedSource = {
      bun: bun.source,
      alpine: {
        branch: ALPINE_BRANCH,
        arch: alpineArch,
        packages: APK_PACKAGES.map(({ pkg }) => pkg),
      },
    };
    for (const [, dst] of [...sources, ...jniSources]) {
      stagedFiles.push(
        fileProvenanceEntry({
          filePath: dst,
          relativePath: path.relative(
            path.join(androidDir, "app", "src", "main"),
            dst,
          ),
          source: stagedSource,
        }),
      );
    }

    stagedCount += abiChanges;
    tlog(
      `Staged ${sources.length} runtime file(s) for ABI ${androidAbi}` +
        (abiChanges === 0 ? " (cached)" : ` (${abiChanges} updated)`),
    );
  }

  // ABI-independent assets: agent-bundle.js + PGlite payload. The real
  // bundle is produced in packages/agent/dist-mobile/ via
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
  if (!fs.existsSync(distBundle)) {
    throw new Error(
      `No mobile agent bundle found at ${distBundle}. Run ` +
        "`bun run --cwd packages/agent build:mobile` before staging Android assets.",
    );
  }
  const bundleSrc = distBundle;
  tlog(
    `Using mobile agent bundle (${(fs.statSync(distBundle).size / (1024 * 1024)).toFixed(1)} MB)`,
  );
  const bundleTarget = path.join(assetsAgentDir, "agent-bundle.js");
  if (copyIfDifferent(bundleSrc, bundleTarget)) stagedCount += 1;
  stagedFiles.push(
    fileProvenanceEntry({
      filePath: bundleTarget,
      relativePath: path.relative(
        path.join(androidDir, "app", "src", "main"),
        bundleTarget,
      ),
      source: {
        kind: "mobile-agent-bundle",
        path: bundleSrc,
      },
    }),
  );

  // PGlite runtime artifacts. They are optional because minimal mobile bundles
  // can run without embedded database extensions.
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
    stagedFiles.push(
      fileProvenanceEntry({
        filePath: dst,
        relativePath: path.relative(
          path.join(androidDir, "app", "src", "main"),
          dst,
        ),
        source: {
          kind: "mobile-agent-bundle",
          path: src,
        },
      }),
    );
  }

  const launchTarget = path.join(assetsAgentDir, "launch.sh");
  if (writeIfChanged(launchTarget, LAUNCH_SCRIPT)) stagedCount += 1;
  stagedFiles.push(
    fileProvenanceEntry({
      filePath: launchTarget,
      relativePath: path.relative(
        path.join(androidDir, "app", "src", "main"),
        launchTarget,
      ),
      source: { kind: "stage-android-agent", constant: "LAUNCH_SCRIPT" },
    }),
  );
  const launchChildTarget = path.join(assetsAgentDir, "launch-child.sh");
  if (writeIfChanged(launchChildTarget, LAUNCH_CHILD_SCRIPT)) stagedCount += 1;
  stagedFiles.push(
    fileProvenanceEntry({
      filePath: launchChildTarget,
      relativePath: path.relative(
        path.join(androidDir, "app", "src", "main"),
        launchChildTarget,
      ),
      source: { kind: "stage-android-agent", constant: "LAUNCH_CHILD_SCRIPT" },
    }),
  );
  const llamaDiagnosticTarget = path.join(
    assetsAgentDir,
    "llama-kernel-diagnostic.mjs",
  );
  if (writeIfChanged(llamaDiagnosticTarget, LLAMA_KERNEL_DIAGNOSTIC_SCRIPT)) {
    stagedCount += 1;
  }
  stagedFiles.push(
    fileProvenanceEntry({
      filePath: llamaDiagnosticTarget,
      relativePath: path.relative(
        path.join(androidDir, "app", "src", "main"),
        llamaDiagnosticTarget,
      ),
      source: {
        kind: "stage-android-agent",
        constant: "LLAMA_KERNEL_DIAGNOSTIC_SCRIPT",
      },
    }),
  );

  const bunRiscv64VersionPath = path.resolve(
    __dirname,
    "..",
    "bun-riscv64",
    "bun-version.json",
  );
  const runtimeProvenanceTarget = path.join(
    assetsAgentDir,
    RUNTIME_PROVENANCE_FILENAME,
  );
  const runtimeProvenance = {
    schema: "eliza.android_agent_runtime_provenance.v1",
    generated_by: "packages/app-core/scripts/lib/stage-android-agent.mjs",
    claim_boundary:
      "apk_staged_runtime_file_hashes_only_not_android_boot_or_runtime_execution_evidence",
    bun: {
      version: BUN_VERSION,
      channel: bunChannel,
      cache_key: bunCacheKey(bunChannel),
    },
    alpine: {
      branch: ALPINE_BRANCH,
    },
    riscv64_bun_artifact: riscv64Artifact,
    riscv64_bun_build_contract: readJsonIfExists(bunRiscv64VersionPath),
    files: stagedFiles.sort((a, b) => a.path.localeCompare(b.path)),
  };
  if (
    writeIfChanged(
      runtimeProvenanceTarget,
      `${JSON.stringify(runtimeProvenance, null, 2)}\n`,
    )
  ) {
    stagedCount += 1;
  }

  tlog(
    `Staged on-device agent runtime in ${path.relative(androidDir, assetsAgentDir)} ` +
      `(${stagedCount} file change${stagedCount === 1 ? "" : "s"} this run).`,
  );

  return {
    assetsAgentDir,
    stagedCount,
    runtimeProvenancePath: runtimeProvenanceTarget,
  };
}

export const __testables = {
  BUN_VERSION,
  ALPINE_BRANCH,
  ABI_TARGETS,
  APK_PACKAGES,
  LAUNCH_SCRIPT,
  LLAMA_KERNEL_DIAGNOSTIC_SCRIPT,
  RISCV64_BUN_ARTIFACT_FILENAME,
  RUNTIME_PROVENANCE_FILENAME,
  defaultRiscv64BunArtifactPath,
  riscv64BunFilePath,
  riscv64BunArtifactSource,
  riscv64BunSha256,
  resolveZigToolchain,
  provenancePath,
};
