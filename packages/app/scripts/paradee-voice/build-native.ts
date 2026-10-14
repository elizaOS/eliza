#!/usr/bin/env node
/**
 * Builds the generated inputs of the paradee-voice Android library:
 *   jniLibs/<abi>/libelizainference.so   (stage-elizavoice-lib.ts: Paradee +
 *                                         misaki G2P + eSpeak NG fallback)
 *   assets/paradee-voice/v1/...          (Paradee GGUF, misaki lexicon, English
 *                                         eSpeak NG data, notices, manifest)
 *   build-record.json                    (SHA-256 of every file above;
 *                                         consumer.gradle checks it)
 *
 * The GGUF and the lexicon are converted in the llama.cpp fork from pinned
 * sources: tools/paradee/convert_paradee_pt_to_gguf.py reads the PyTorch
 * weights of sahilmahendrakar/Paradee-8M-v1.0 at the revision in
 * tools/paradee/pins.json, and tools/misaki-g2p/convert_misaki_lexicon.py
 * reads the misaki dictionaries in tools/misaki-g2p/pins.json. Both outputs
 * are byte-reproducible and must match paradee-voice/inputs.json, which must
 * match the fork pins.
 *
 *   node packages/app/scripts/paradee-voice/build-native.ts --workspace <dir> \
 *     [--out <native dir>] [--abi arm64-v8a] [--abi x86_64] \
 *     [--model-cache <dir>] [--python <python with torch>]
 *
 * --workspace holds downloads and build trees. --out defaults to
 * packages/app/platforms/android/paradee-voice/native. --model-cache is
 * searched (recursively, by file name) for an already converted GGUF or
 * lexicon before converting. --python runs the converters (default python3;
 * the GGUF converter needs torch and numpy).
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
  "packages/app/platforms/android/paradee-voice",
);
const forkSrc = path.join(
  repoRoot,
  "plugins/plugin-local-inference/native/llama.cpp",
);
const inputs = JSON.parse(
  readFileSync(path.join(moduleDir, "inputs.json"), "utf8"),
);
const NDK_VERSION = "28.2.13676358";
const ABIS = ["arm64-v8a", "x86_64"];
const BUNDLE = "assets/paradee-voice/v1";

function log(message) {
  process.stdout.write(`[paradee-voice] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[paradee-voice] ERROR: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    workspace: "",
    out: path.join(moduleDir, "native"),
    abis: [],
    modelCache: "",
    python: "python3",
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--workspace") args.workspace = path.resolve(value);
    else if (argv[i] === "--out") args.out = path.resolve(value);
    else if (argv[i] === "--abi") args.abis.push(value);
    else if (argv[i] === "--model-cache") args.modelCache = path.resolve(value);
    else if (argv[i] === "--python") args.python = value;
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

async function download(url, pin, target) {
  if (await matches(target, pin)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  log(`fetch ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) fail(`${url} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== pin.bytes || digest !== pin.sha256) {
    fail(
      `${url} is ${bytes.length} bytes sha256 ${digest}; expected ${pin.bytes} ${pin.sha256}`,
    );
  }
  writeFileSync(`${target}.partial`, bytes);
  renameSync(`${target}.partial`, target);
}

/** inputs.json must name the same artifacts the fork pins. */
function forkPins() {
  const paradee = JSON.parse(
    readFileSync(path.join(forkSrc, "tools/paradee/pins.json"), "utf8"),
  );
  const misaki = JSON.parse(
    readFileSync(path.join(forkSrc, "tools/misaki-g2p/pins.json"), "utf8"),
  );
  const gguf = paradee.gguf?.f32;
  const checks = [
    ["paradee GGUF", inputs.paradee, gguf?.sha256, gguf?.size],
    [
      "misaki lexicon",
      inputs.lexicon,
      misaki.lexicon?.sha256,
      misaki.lexicon?.bytes,
    ],
    [
      "eSpeak NG",
      inputs.espeak,
      misaki.espeak_ng?.sha256,
      misaki.espeak_ng?.bytes,
    ],
  ];
  for (const [name, pin, sha, bytes] of checks) {
    if (!sha || pin.sha256 !== sha || pin.bytes !== bytes) {
      fail(
        `${name}: inputs.json pins ${pin.bytes} ${pin.sha256}, the fork pins ${bytes} ${sha}`,
      );
    }
  }
  return { paradee, misaki };
}

/** Copies a converted file from the target itself or the model cache. */
async function fromCache(pin, target, cacheDir) {
  if (await matches(target, pin)) return true;
  const cached = findByName(cacheDir, path.basename(target));
  if (!cached || !(await matches(cached, pin))) return false;
  log(`cache ${cached}`);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(cached, target);
  return true;
}

/** Runs `convert(output)` and keeps the output only when it matches the pin. */
async function convertTo(pin, target, convert) {
  mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  rmSync(partial, { force: true });
  convert(partial);
  if (!(await matches(partial, pin))) {
    fail(
      `${path.basename(target)} converted to ${statSync(partial).size} bytes sha256 ${await sha256(partial)}; expected ${pin.bytes} ${pin.sha256}`,
    );
  }
  renameSync(partial, target);
}

async function buildModels(args, pins, bundle) {
  // Paradee GGUF from the pinned PyTorch weights, config and tokenizer.
  const gguf = path.join(bundle, inputs.paradee.path);
  if (!(await fromCache(inputs.paradee, gguf, args.modelCache))) {
    const hfDir = path.join(args.workspace, "paradee-hf");
    const { repo, revision } = pins.paradee.model;
    for (const [file, pin] of Object.entries(pins.paradee.files)) {
      if (file.startsWith("samples/")) continue;
      await download(
        `https://huggingface.co/${repo}/resolve/${revision}/${file}`,
        { bytes: pin.size, sha256: pin.sha256 },
        path.join(hfDir, file),
      );
    }
    await convertTo(inputs.paradee, gguf, (output) =>
      run(args.python, [
        path.join(forkSrc, "tools/paradee/convert_paradee_pt_to_gguf.py"),
        "--model-dir",
        hfDir,
        "--output",
        output,
        "--outtype",
        "f32",
        "--check-output",
      ]),
    );
  }

  // misaki lexicon from the pinned misaki dictionaries.
  const lexicon = path.join(bundle, inputs.lexicon.path);
  if (!(await fromCache(inputs.lexicon, lexicon, args.modelCache))) {
    await convertTo(inputs.lexicon, lexicon, (output) =>
      run(args.python, [
        path.join(forkSrc, "tools/misaki-g2p/convert_misaki_lexicon.py"),
        "--fetch",
        path.join(args.workspace, "misaki"),
        "--output",
        output,
      ]),
    );
  }
}

function buildInference(args, espeakDir) {
  for (const abi of args.abis) {
    run(
      "node",
      [
        path.join(repoRoot, "packages/app/scripts/stage-elizavoice-lib.ts"),
        "--abi",
        abi,
        "--out",
        path.join(args.out, "jniLibs", abi),
        "--espeak-dir",
        espeakDir,
      ],
      { env: { ...process.env, ELIZA_NDK_VERSION: NDK_VERSION } },
    );
    // The library's own CMake build packages libc++_shared.so from the same
    // NDK; a second copy in jniLibs would collide during APK merge.
    rmSync(path.join(args.out, "jniLibs", abi, "libc++_shared.so"), {
      force: true,
    });
  }
}

function copyTree(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) {
      mkdirSync(to, { recursive: true });
      copyFileSync(source, target);
    }
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
  if (!existsSync(path.join(sdk, "ndk", NDK_VERSION)))
    fail(`NDK ${NDK_VERSION} not installed under ${path.join(sdk, "ndk")}`);
  mkdirSync(args.workspace, { recursive: true });
  const pins = forkPins();
  // Rebuild generated assets from scratch so a removed input cannot linger.
  const bundle = path.join(args.out, BUNDLE);
  rmSync(path.join(args.out, "assets"), { recursive: true, force: true });

  const espeakDir = path.join(args.workspace, "espeak-ng");
  buildInference(args, espeakDir);
  await buildModels(args, pins, bundle);

  const paradeeDir = path.dirname(path.join(bundle, inputs.paradee.path));
  copyTree(
    path.join(espeakDir, "data", "espeak-ng-data"),
    path.join(paradeeDir, "espeak-ng-data"),
  );
  const notices = path.join(bundle, "notices");
  mkdirSync(notices, { recursive: true });
  copyFileSync(
    path.join(espeakDir, "COPYING"),
    path.join(notices, "espeak-ng-COPYING"),
  );
  copyTree(path.join(forkSrc, "tools/misaki-g2p/LICENSES"), notices);

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
    format: "eliza-paradee-voice-v1",
    model: inputs.paradee.path,
    lexicon: inputs.lexicon.path,
    espeakDir: path.relative(bundle, paradeeDir),
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
