import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGrizzlyBuildFingerprint } from "../aosp/build-grizzly-bundle.mjs";

const prefix = "elizaOS/eliza_grizzly_phone/grizzly:";
const fingerprint = `${prefix}Baklava/CP2A.260605.016/eng.shawwa:userdebug/test-keys`;

test("accepts the canonical Android 17 product fingerprint with optional final newline", () => {
  for (const ending of ["", "\n", "\r\n"]) {
    assert.equal(
      parseGrizzlyBuildFingerprint(fingerprint + ending, prefix),
      fingerprint,
    );
  }
});

test("rejects generic-system, stock, wrong-target and non-userdebug identities", () => {
  for (const value of [
    fingerprint.replace(prefix, "Android/generic_system/generic:"),
    "google/grizzly/grizzly:17/CD1A.260714.001.A9/15938155:user/release-keys",
    fingerprint.replace("/grizzly:", "/another_device:"),
    fingerprint.replace("userdebug/test-keys", "user/release-keys"),
    fingerprint.replace("userdebug/test-keys", "userdebug/release-keys"),
  ]) {
    assert.throws(
      () => parseGrizzlyBuildFingerprint(value, prefix),
      /locked grizzly userdebug identity/,
    );
  }
});

test("rejects missing, truncated, ambiguous and property-file-shaped receipts", () => {
  for (const value of [
    "",
    prefix,
    `${fingerprint}\n${fingerprint}`,
    `${fingerprint}\n\n`,
    ` ${fingerprint}`,
    `${fingerprint} `,
    `ro.build.fingerprint=${fingerprint}`,
    fingerprint.replace("/eng.shawwa:", "/:"),
  ]) {
    assert.throws(
      () => parseGrizzlyBuildFingerprint(value, prefix),
      /locked grizzly userdebug identity/,
    );
  }
  assert.throws(
    () => parseGrizzlyBuildFingerprint(fingerprint, ""),
    /locked grizzly userdebug identity/,
  );
});
