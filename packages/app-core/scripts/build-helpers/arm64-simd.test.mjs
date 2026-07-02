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

// The default floor is asserted against LITERALS, never against the imported
// constants — asserting `flags === -D...=${ANDROID_ARM64_CPU_ARCH}` is a
// tautology that stays green if someone re-adds +i8mm to the constant itself
// (SIGILL on every pre-armv8.6 device: Pixel 6/6a/6 Pro/7, issue #10727).
test("uses the Pixel-safe arm64 floor by default", () => {
  delete process.env.ELIZA_ANDROID_ARM64_I8MM;

  assert.ok(
    !ANDROID_ARM64_CPU_ARCH.includes("i8mm"),
    "default arm64 floor must never include i8mm (SIGILL on Tensor G1/G2)",
  );
  assert.equal(ANDROID_ARM64_CPU_ARCH, "armv8.2-a+dotprod+fp16");

  assert.deepEqual(androidArm64SimdCmakeFlags("arm64-v8a"), [
    "-DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16",
    "-DGGML_USE_DOTPROD=ON",
  ]);
});

test("can opt in to i8mm for known-compatible Android arm64 devices", () => {
  process.env.ELIZA_ANDROID_ARM64_I8MM = "1";

  assert.equal(ANDROID_ARM64_CPU_ARCH_I8MM, "armv8.2-a+dotprod+fp16+i8mm");

  assert.deepEqual(androidArm64SimdCmakeFlags("arm64-v8a"), [
    "-DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16+i8mm",
    "-DGGML_USE_DOTPROD=ON",
  ]);
});

test("does not add arm64 flags to other Android ABIs", () => {
  process.env.ELIZA_ANDROID_ARM64_I8MM = "1";

  assert.deepEqual(androidArm64SimdCmakeFlags("x86_64"), []);
});
