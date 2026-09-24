import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  targetAbi,
  verifyNativeRuntimeTarget,
} from "../aosp/verify-native-runtime.ts";

const symbols = [
  "eliza_inference_abi_version",
  "eliza_inference_create",
  "eliza_inference_destroy",
  "eliza_inference_asr_transcribe",
  "eliza_inference_tts_synthesize",
  "eliza_inference_llm_stream_open",
  "eliza_inference_embed",
];

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "elizaos-android-native-"));
  const directory = join(root, "arm64-v8a");
  mkdirSync(directory);
  const elfHeader = Buffer.alloc(20);
  elfHeader.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  elfHeader.writeUInt16LE(3, 16);
  elfHeader.writeUInt16LE(183, 18);
  writeFileSync(join(directory, "libelizainference.so"), elfHeader);
  writeFileSync(
    join(directory, "OMNIVOICE_FUSE_VERIFY.json"),
    JSON.stringify({
      ok: true,
      target: "android-arm64-cpu-fused",
      abiSymbols: symbols,
      ...overrides,
    }),
  );
  return root;
}

test("accepts the exact CPU-fused target with critical runtime symbols", () => {
  const result = verifyNativeRuntimeTarget(
    fixture(),
    "android-arm64-cpu-fused",
  );
  assert.equal(result.abi, "arm64-v8a");
  assert.ok(result.sizeBytes > 0);
});

test("rejects Vulkan, mismatched evidence, and missing ASR", () => {
  assert.throws(
    () => targetAbi("android-arm64-vulkan-fused"),
    /only Android CPU-fused targets are permitted/,
  );
  assert.throws(
    () =>
      verifyNativeRuntimeTarget(
        fixture({ target: "android-x86_64-cpu-fused" }),
        "android-arm64-cpu-fused",
      ),
    /evidence describes/,
  );
  assert.throws(
    () =>
      verifyNativeRuntimeTarget(
        fixture({
          abiSymbols: symbols.filter(
            (symbol) => symbol !== "eliza_inference_asr_transcribe",
          ),
        }),
        "android-arm64-cpu-fused",
      ),
    /eliza_inference_asr_transcribe/,
  );
});

test("rejects a non-ELF or wrong-architecture library", () => {
  const wrongArchitecture = fixture();
  const wrongPath = join(
    wrongArchitecture,
    "arm64-v8a",
    "libelizainference.so",
  );
  const elfHeader = Buffer.alloc(20);
  elfHeader.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  elfHeader.writeUInt16LE(3, 16);
  elfHeader.writeUInt16LE(62, 18);
  writeFileSync(wrongPath, elfHeader);
  assert.throws(
    () =>
      verifyNativeRuntimeTarget(wrongArchitecture, "android-arm64-cpu-fused"),
    /ELF machine 62 does not match arm64-v8a/,
  );
});
