#!/usr/bin/env node
/** Verify fused Android inference artifacts before they enter an AOSP image. */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { isMainModule } from "../distro-android/is-main.mjs";

const ABI_BY_ARCH = Object.freeze({
  arm64: "arm64-v8a",
  x86_64: "x86_64",
  riscv64: "riscv64",
});

const ELF_MACHINE_BY_ABI = Object.freeze({
  "arm64-v8a": 183,
  x86_64: 62,
  riscv64: 243,
});

const REQUIRED_ABI_SYMBOLS = Object.freeze([
  "eliza_inference_abi_version",
  "eliza_inference_create",
  "eliza_inference_destroy",
  "eliza_inference_asr_transcribe",
  "eliza_inference_tts_synthesize",
  "eliza_inference_llm_stream_open",
  "eliza_inference_embed",
]);

function fail(message) {
  throw new Error(`[android-native-runtime] ${message}`);
}

export function targetAbi(target) {
  const match = /^android-(arm64|x86_64|riscv64)-cpu-fused$/.exec(target);
  if (!match) {
    fail(
      `unsupported release target ${target}; only Android CPU-fused targets are permitted`,
    );
  }
  return ABI_BY_ARCH[match[1]];
}

function verifyElfHeader(libraryPath, abi) {
  const header = Buffer.alloc(20);
  const descriptor = openSync(libraryPath, "r");
  try {
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      fail(`${libraryPath} is too small to be an ELF shared object`);
    }
  } finally {
    closeSync(descriptor);
  }
  if (
    header[0] !== 0x7f ||
    header[1] !== 0x45 ||
    header[2] !== 0x4c ||
    header[3] !== 0x46 ||
    header[4] !== 2 ||
    header[5] !== 1
  ) {
    fail(`${libraryPath} is not a 64-bit little-endian ELF file`);
  }
  const type = header.readUInt16LE(16);
  const machine = header.readUInt16LE(18);
  if (type !== 3) fail(`${libraryPath} is not an ELF shared object`);
  if (machine !== ELF_MACHINE_BY_ABI[abi]) {
    fail(`${libraryPath} ELF machine ${machine} does not match ${abi}`);
  }
}

export function verifyNativeRuntimeTarget(assetRoot, target) {
  const abi = targetAbi(target);
  const directory = resolve(assetRoot, abi);
  const evidencePath = resolve(directory, "OMNIVOICE_FUSE_VERIFY.json");
  const libraryPath = resolve(directory, "libelizainference.so");
  if (!existsSync(evidencePath)) fail(`${target} is missing ${evidencePath}`);
  if (!existsSync(libraryPath) || !statSync(libraryPath).isFile()) {
    fail(`${target} is missing ${libraryPath}`);
  }
  if (statSync(libraryPath).size === 0) fail(`${libraryPath} is empty`);
  verifyElfHeader(libraryPath, abi);

  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch (error) {
    fail(`${evidencePath} is not valid JSON: ${String(error)}`);
  }
  if (evidence.ok !== true) fail(`${target} fused verification is not ok`);
  if (evidence.target !== target) {
    fail(`${target} evidence describes ${String(evidence.target)}`);
  }
  if (!Array.isArray(evidence.abiSymbols)) {
    fail(`${target} evidence has no ABI symbol inventory`);
  }
  const symbols = new Set(evidence.abiSymbols);
  const missingSymbols = REQUIRED_ABI_SYMBOLS.filter(
    (symbol) => !symbols.has(symbol),
  );
  if (missingSymbols.length > 0) {
    fail(`${target} is missing required symbols: ${missingSymbols.join(", ")}`);
  }
  return {
    target,
    abi,
    libraryPath,
    sizeBytes: statSync(libraryPath).size,
    sha256: createHash("sha256")
      .update(readFileSync(libraryPath))
      .digest("hex"),
    abiSymbolCount: symbols.size,
  };
}

function parseArgs(argv) {
  let assetRoot = "";
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--asset-root") assetRoot = argv[++index] ?? "";
    else if (argument === "--target") targets.push(argv[++index] ?? "");
    else fail(`unknown argument ${argument}`);
  }
  if (!assetRoot) fail("--asset-root is required");
  if (targets.length === 0 || targets.some((target) => !target)) {
    fail("at least one non-empty --target is required");
  }
  if (new Set(targets).size !== targets.length) fail("targets must be unique");
  return { assetRoot, targets };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const results = options.targets.map((target) =>
    verifyNativeRuntimeTarget(options.assetRoot, target),
  );
  process.stdout.write(`${JSON.stringify({ pass: true, results }, null, 2)}\n`);
  return results;
}

if (isMainModule(import.meta)) main();
