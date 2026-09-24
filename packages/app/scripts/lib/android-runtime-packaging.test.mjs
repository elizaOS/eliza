/** Exercises native-runtime packaging policy with real Gradle-template bytes and deterministic fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  ANDROID_RUNTIME_PACKAGING_DIRECTIVE,
  injectAndroidRuntimeBytePreservation,
} from "./android-runtime-packaging.mjs";

for (const [name, content] of Object.entries({
  minimal: "android {\n}\n",
  existingPackaging:
    "android { packaging { resources { excludes += ['META-INF/NOTICE'] } } }\n",
  existingJni:
    "android { packaging { jniLibs { useLegacyPackaging = true } } }\n",
  existingSymbols:
    "android { packaging { jniLibs { keepDebugSymbols = ['**/camera.so'] } } }\n",
})) {
  test(`preserves runtime bytes with ${name} configuration`, () => {
    const result = injectAndroidRuntimeBytePreservation(content);
    assert.ok(result.startsWith(content.trimEnd()));
    assert.ok(result.endsWith(`${ANDROID_RUNTIME_PACKAGING_DIRECTIVE}\n`));
    assert.equal(injectAndroidRuntimeBytePreservation(result), result);
  });
}

test("does not treat a commented directive as active configuration", () => {
  const content = `android {}\n// ${ANDROID_RUNTIME_PACKAGING_DIRECTIVE}\n`;
  const result = injectAndroidRuntimeBytePreservation(content);
  assert.ok(result.endsWith(`${ANDROID_RUNTIME_PACKAGING_DIRECTIVE}\n`));
});

test("keeps an already configured CRLF file unchanged", () => {
  const content = `android {}\r\n${ANDROID_RUNTIME_PACKAGING_DIRECTIVE}\r\n`;
  assert.equal(injectAndroidRuntimeBytePreservation(content), content);
});

test("rejects missing Android configuration", () => {
  for (const content of ["", "plugins {}\n", "not_android {}\n"]) {
    assert.throws(
      () => injectAndroidRuntimeBytePreservation(content),
      /requires an android/,
    );
  }
});

test("maintained Android template already carries the same runtime policy", () => {
  const template = fs.readFileSync(
    new URL("../../platforms/android/app/build.gradle", import.meta.url),
    "utf8",
  );
  assert.equal(injectAndroidRuntimeBytePreservation(template), template);
});
