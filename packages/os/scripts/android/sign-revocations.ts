#!/usr/bin/env node
import { createPrivateKey, sign } from "node:crypto";
import fs from "node:fs";
import { readJson, requireThat } from "./release-contract.ts";

try {
  const [input, keyId, keyFile, output] = process.argv.slice(2);
  requireThat(
    process.argv.length === 6,
    "usage: sign-revocations BULLETIN KEY_ID PRIVATE_KEY OUTPUT",
  );
  const b = readJson(input);
  requireThat(
    b.schemaVersion === 1 &&
      Number.isSafeInteger(b.sequence) &&
      b.sequence >= 1 &&
      Number.isFinite(Date.parse(b.issuedAt)) &&
      Date.parse(b.expiresAt) > Date.parse(b.issuedAt) &&
      Array.isArray(b.revokedReleaseDigests) &&
      b.revokedReleaseDigests.every((x) => /^[a-f0-9]{64}$/.test(x)) &&
      Array.isArray(b.revokedKeyIds) &&
      b.revokedKeyIds.every((x) => typeof x === "string"),
    "invalid revocation bulletin",
  );
  const key = createPrivateKey(fs.readFileSync(keyFile));
  requireThat(key.asymmetricKeyType === "ed25519", "Ed25519 key required");
  b.keyId = keyId;
  b.signature = sign(
    null,
    Buffer.from(
      JSON.stringify([
        b.schemaVersion,
        b.sequence,
        b.issuedAt,
        b.expiresAt,
        b.revokedReleaseDigests,
        b.revokedKeyIds,
      ]),
    ),
    key,
  ).toString("base64");
  fs.writeFileSync(output, `${JSON.stringify(b, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
