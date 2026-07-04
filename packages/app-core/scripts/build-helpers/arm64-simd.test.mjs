/** Exercises arm64 simd behavior with deterministic app-core test fixtures. */
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

  // Literal guard (#11201): the DEFAULT floor must never bake i8mm — smmla
  // SIGILLs on every pre-armv8.6 core (Tensor G1/G2 = Pixel 6/6a/7). Asserting
  // the function output against ANDROID_ARM64_CPU_ARCH alone is tautological
  // (re-adding "+i8mm" shifts both sides together), so pin the literal too.
  assert.ok(
    !ANDROID_ARM64_CPU_ARCH.includes("i8mm"),
    `default arm64 floor must not include i8mm; got ${ANDROID_ARM64_CPU_ARCH}`,
  );
  assert.equal(ANDROID_ARM64_CPU_ARCH, "armv8.2-a+dotprod+fp16");

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
