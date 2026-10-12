#!/usr/bin/env node
/**
 * Builds the generated inputs of the kokoro-voice Android library:
 *   espeak/<abi>/libespeak-ng.a, libucd.a, espeak/include  (eSpeak NG 1.52.0, NDK)
 *   jniLibs/<abi>/libelizainference.so, libc++_shared.so  (stage-elizavoice-lib.ts, Kokoro ON)
 *   assets/kokoro-voice/v1/...  (English eSpeak data, Kokoro GGUF, voice preset, manifest)
 *   build-record.json  (SHA-256 of every file above; consumer.gradle checks it)
 *
 * Every download is pinned by size and SHA-256 in kokoro-voice/inputs.json.
 *
 *   node packages/app/scripts/kokoro-voice/build-native.ts --workspace <dir> \
 *     [--out <native dir>] [--abi arm64-v8a] [--abi x86_64] [--model-cache <dir>]
 *
 * --workspace holds downloads and build trees. --out defaults to
 * packages/app/platforms/android/kokoro-voice/native. --model-cache is a
 * directory searched (recursively, by file name) before Hugging Face.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const moduleDir = path.join(
  repoRoot,
  "packages/app/platforms/android/kokoro-voice",
);
const inputs = JSON.parse(
  readFileSync(path.join(moduleDir, "inputs.json"), "utf8"),
);
const NDK_VERSION = "28.2.13676358";
const ABIS = ["arm64-v8a", "x86_64"];

function log(message) {
  process.stdout.write(`[kokoro-voice] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[kokoro-voice] ERROR: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    workspace: "",
    out: path.join(moduleDir, "native"),
    abis: [],
    modelCache: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--workspace") args.workspace = path.resolve(value);
    else if (argv[i] === "--out") args.out = path.resolve(value);
    else if (argv[i] === "--abi") args.abis.push(value);
    else if (argv[i] === "--model-cache") args.modelCache = path.resolve(value);
    else fail(`unknown argument ${argv[i]}`);
    i++;
  }
  if (!args.workspace) fail("--workspace is required");
  if (args.abis.length === 0) args.abis = ABIS;
  for (const abi of args.abis)
    if (!ABIS.includes(abi)) fail(`unsupported --abi ${abi}`);
  return args;
}

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function matches(file, pin) {
  return (
    existsSync(file) &&
    statSync(file).size === pin.bytes &&
    (await sha256(file)) === pin.sha256
  );
}

function findByName(dir, name) {
  if (!dir || !existsSync(dir)) return "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findByName(full, name);
      if (found) return found;
    }
  }
  return "";
}

/** Places a pinned file at `target`: cached copy, then the pinned URL. */
async function acquire(pin, target, cacheDir) {
  if (await matches(target, pin)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  const cached = findByName(cacheDir, path.basename(pin.path ?? target));
  if (cached && (await matches(cached, pin))) {
    log(`cache ${cached}`);
    copyFileSync(cached, target);
    return;
  }
  log(`fetch ${pin.url}`);
  const response = await fetch(pin.url, { redirect: "follow" });
  if (!response.ok) fail(`${pin.url} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== pin.bytes || digest !== pin.sha256) {
    fail(
      `${pin.url} is ${bytes.length} bytes sha256 ${digest}; expected ${pin.bytes} ${pin.sha256}`,
    );
  }
  writeFileSync(`${target}.partial`, bytes);
  renameSync(`${target}.partial`, target);
}

function espeakCmakeFlags() {
  // Only the phonemizer is used: no audio output, sonic, MBROLA, or synthesizers.
  return [
    "-G",
    "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DBUILD_TESTING=OFF",
    "-DUSE_ASYNC=OFF",
    "-DUSE_MBROLA=OFF",
    "-DUSE_LIBPCAUDIO=OFF",
    "-DPCAUDIO_LIB=PCAUDIO_LIB-NOTFOUND",
    // Setting the sonic paths stops deps.cmake from cloning sonic at configure time.
    "-DUSE_LIBSONIC=OFF",
    "-DSONIC_LIB=UNUSED",
    "-DSONIC_INC=UNUSED",
  ];
}

async function buildEspeak(args, ndk) {
  const pin = inputs.espeak;
  const archive = path.join(
    args.workspace,
    "downloads",
    `espeak-ng-${pin.version}.tar.gz`,
  );
  await acquire(pin, archive, "");
  const source = path.join(args.workspace, `espeak-ng-${pin.version}`);
  if (!existsSync(path.join(source, "CMakeLists.txt"))) {
    run("tar", ["-xzf", archive, "-C", args.workspace]);
  }

  // The data compiler must run on the build host, so compile English data with
  // a host build of the same source. The compiled data is ABI independent.
  const hostBuild = path.join(args.workspace, "espeak-host");
  run("cmake", ["-S", source, "-B", hostBuild, ...espeakCmakeFlags()]);
  run("ninja", [
    "-C",
    hostBuild,
    "espeak-ng-data/intonations",
    "espeak-ng-data/phondata",
    "espeak-ng-data/en_dict",
  ]);
  const dataOut = path.join(
    args.out,
    "assets/kokoro-voice/v1/espeak/espeak-ng-data",
  );
  for (const relative of pin.data) {
    mkdirSync(path.dirname(path.join(dataOut, relative)), { recursive: true });
    copyFileSync(
      path.join(hostBuild, "espeak-ng-data", relative),
      path.join(dataOut, relative),
    );
  }
  const notices = path.join(args.out, "assets/kokoro-voice/v1/notices");
  mkdirSync(notices, { recursive: true });
  copyFileSync(
    path.join(source, "COPYING"),
    path.join(notices, "espeak-ng-COPYING"),
  );

  const include = path.join(args.out, "espeak/include/espeak-ng");
  mkdirSync(include, { recursive: true });
  copyFileSync(
    path.join(source, "src/include/espeak-ng/speak_lib.h"),
    path.join(include, "speak_lib.h"),
  );
  for (const abi of args.abis) {
    const build = path.join(args.workspace, `espeak-${abi}`);
    run("cmake", [
      "-S",
      source,
      "-B",
      build,
      ...espeakCmakeFlags(),
      `-DCMAKE_TOOLCHAIN_FILE=${path.join(ndk, "build/cmake/android.toolchain.cmake")}`,
      `-DANDROID_ABI=${abi}`,
      "-DANDROID_PLATFORM=android-26",
      "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
      "-DUSE_KLATT=OFF",
      "-DUSE_SPEECHPLAYER=OFF",
    ]);
    run("ninja", ["-C", build, "espeak-ng"]);
    const libDir = path.join(args.out, "espeak", abi);
    mkdirSync(libDir, { recursive: true });
    copyFileSync(
      path.join(build, "src/libespeak-ng/libespeak-ng.a"),
      path.join(libDir, "libespeak-ng.a"),
    );
    copyFileSync(
      path.join(build, "src/ucd-tools/libucd.a"),
      path.join(libDir, "libucd.a"),
    );
  }
}

function buildInference(args) {
  for (const abi of args.abis) {
    run(
      "node",
      [
        path.join(repoRoot, "packages/app/scripts/stage-elizavoice-lib.ts"),
        "--abi",
        abi,
        "--out",
        path.join(args.out, "jniLibs", abi),
      ],
      {
        env: { ...process.env, ELIZA_NDK_VERSION: NDK_VERSION },
      },
    );
    // The library's own CMake build packages libc++_shared.so from the same
    // NDK; a second copy in jniLibs would collide during APK merge.
    rmSync(path.join(args.out, "jniLibs", abi, "libc++_shared.so"), {
      force: true,
    });
  }
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) fail("set ANDROID_HOME");
  const ndk = path.join(sdk, "ndk", NDK_VERSION);
  if (!existsSync(ndk))
    fail(`NDK ${NDK_VERSION} not installed under ${path.join(sdk, "ndk")}`);
  mkdirSync(args.workspace, { recursive: true });
  // Rebuild generated assets from scratch so a removed input cannot linger.
  rmSync(path.join(args.out, "assets"), { recursive: true, force: true });

  await buildEspeak(args, ndk);
  buildInference(args);

  const bundle = path.join(args.out, "assets/kokoro-voice/v1");
  await acquire(
    inputs.model,
    path.join(bundle, inputs.model.path),
    args.modelCache,
  );
  await acquire(
    inputs.voice,
    path.join(bundle, inputs.voice.path),
    args.modelCache,
  );

  const files = [];
  for (const file of listFiles(bundle)) {
    if (path.basename(file) === "manifest.json") continue;
    files.push({
      path: path.relative(bundle, file),
      bytes: statSync(file).size,
      sha256: await sha256(file),
    });
  }
  const manifest = {
    format: "eliza-kokoro-voice-v1",
    model: inputs.model.path,
    voice: inputs.voice.path,
    espeakRoot: "espeak",
    files,
  };
  writeFileSync(
    path.join(bundle, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const record = [];
  for (const file of listFiles(args.out)) {
    if (path.basename(file) === "build-record.json") continue;
    record.push({
      path: path.relative(args.out, file),
      bytes: statSync(file).size,
      sha256: await sha256(file),
    });
  }
  writeFileSync(
    path.join(args.out, "build-record.json"),
    `${JSON.stringify({ inputs, abis: args.abis, files: record }, null, 2)}\n`,
  );
  log(`wrote ${record.length} files under ${args.out}`);
}

await main();
