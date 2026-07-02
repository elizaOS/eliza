import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ANDROID_ARM64_CPU_ARCH,
  ANDROID_ARM64_CPU_ARCH_I8MM,
  androidArm64SimdCmakeFlags,
} from "./arm64-simd.mjs";

const ORIGINAL_I8MM = process.env.ELIZA_ANDROID_ARM64_I8MM;

afterEach(() => {
  if (ORIGINAL_I8MM === undefined) {
    delete process.env.ELIZA_ANDROID_ARM64_I8MM;
  } else {
    process.env.ELIZA_ANDROID_ARM64_I8MM = ORIGINAL_I8MM;
  }
});

test("uses the Pixel-safe arm64 floor by default", () => {
  delete process.env.ELIZA_ANDROID_ARM64_I8MM;

  assert.deepEqual(androidArm64SimdCmakeFlags("arm64-v8a"), [
    `-DGGML_CPU_ARM_ARCH=${ANDROID_ARM64_CPU_ARCH}`,
    "-DGGML_USE_DOTPROD=ON",
  ]);
});

test("can opt in to i8mm for known-compatible Android arm64 devices", () => {
  process.env.ELIZA_ANDROID_ARM64_I8MM = "1";

  assert.deepEqual(androidArm64SimdCmakeFlags("arm64-v8a"), [
    `-DGGML_CPU_ARM_ARCH=${ANDROID_ARM64_CPU_ARCH_I8MM}`,
    "-DGGML_USE_DOTPROD=ON",
  ]);
});

test("does not add arm64 flags to other Android ABIs", () => {
  process.env.ELIZA_ANDROID_ARM64_I8MM = "1";

  assert.deepEqual(androidArm64SimdCmakeFlags("x86_64"), []);
});
