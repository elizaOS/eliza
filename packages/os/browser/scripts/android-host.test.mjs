import assert from "node:assert/strict";
import test from "node:test";
import { androidNativeHost } from "./android-host.mjs";

test("Android host identity is explicit and certificate pinned", () => {
  const digest = "ab".repeat(32);
  assert.deepEqual(androidNativeHost(digest, "org.example.helper"), {
    application: "org.example.helper",
    androidCertificates: [digest.toUpperCase()],
  });
  assert.equal(androidNativeHost(digest).application, "ai.elizaos.app");
  for (const application of [
    "",
    "org",
    "org.example;other",
    "org.example\n",
    "a." + "x".repeat(80),
  ])
    assert.throws(
      () => androidNativeHost(digest, application),
      /application ID/,
    );
  for (const certificate of ["", "x".repeat(64), "a".repeat(63), digest + "\n"])
    assert.throws(
      () => androidNativeHost(certificate, "org.example.helper"),
      /certificate/,
    );
});
