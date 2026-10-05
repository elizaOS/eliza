import assert from "node:assert/strict";
import { test } from "node:test";
import { apkSignerSha256 } from "../aosp/build-grizzly-bundle.ts";

const digest =
  "c8a2e9bccf597c2fb6dc66bee293fc13f2fc47ec77bc6b2b0d52c11f51192ab8";
const certificate = (label = "V3.0 Signer:", hash = digest) =>
  `${label} certificate SHA-256 digest: ${hash}`;
const receipt = (...records) =>
  ["Verifies", "Number of signers: 1", ...records].join("\n");

test("reads the pinned apksigner V3.0 receipt without confusing public-key digests", () => {
  assert.equal(
    apkSignerSha256(
      receipt(
        "Verified using v3 scheme (APK Signature Scheme v3): true",
        "V3.0 Signer: certificate DN: CN=Android",
        certificate(),
        `V3.0 Signer: public key SHA-256 digest: ${"a".repeat(64)}`,
      ),
    ),
    digest,
  );
});

test("accepts single legacy and current non-rotated signer labels and CRLF", () => {
  for (const label of [
    "Signer #1",
    "Signer:",
    "V1 Signer:",
    "V2 Signer:",
    "V3.0 Signer:",
  ]) {
    assert.equal(
      apkSignerSha256(
        receipt(certificate(label, digest.toUpperCase())).replaceAll(
          "\n",
          "\r\n",
        ),
      ),
      digest,
    );
  }
});

test("rejects missing, contradictory, repeated and malformed signer counts", () => {
  for (const count of [
    "",
    "Number of signers: 0",
    "Number of signers: 2",
    "Number of signers: 01",
    "Number of signers: 1\nNumber of signers: 1",
  ]) {
    assert.throws(
      () => apkSignerSha256(`${count}\n${certificate()}`),
      /exactly one/,
    );
  }
});

test("rejects absent, duplicate, rotated, unknown and malformed certificates", () => {
  for (const records of [
    [],
    [certificate(), certificate()],
    [certificate(), certificate("Signer #2", "a".repeat(64))],
    [certificate("V3.1 Signer (minSdkVersion=33, maxSdkVersion=2147483647):")],
    [certificate("V3.2 Hybrid Classical Signer:")],
    [certificate("Source Stamp Signer")],
    [certificate("Unknown Signer:")],
    [certificate("Signer #2")],
    [certificate("V3.0 Signer:", digest.slice(1))],
    [certificate("V3.0 Signer:", `${digest}0`)],
    [certificate("V3.0 Signer:", "g".repeat(64))],
    [`prefix ${certificate()}`],
    [`${certificate()} trailing`],
    [certificate(), "Unknown certificate SHA-256 digest: malformed"],
  ]) {
    assert.throws(() => apkSignerSha256(receipt(...records)), /exactly one/);
  }
});
