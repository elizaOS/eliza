#!/usr/bin/env node
/** Offline signing only; never creates keys or enrolls trust automatically. */
import { createPrivateKey, sign } from "node:crypto";
import fs from "node:fs";
import {
  canonical,
  readJson,
  requireThat,
  sha256,
  validateReleaseShape,
} from "./release-contract.mjs";

try {
  const [input, role, keyId, keyFile, output] = process.argv.slice(2);
  requireThat(
    process.argv.length === 7 &&
      ["release", "qualification"].includes(role) &&
      /^[A-Za-z0-9._-]+$/.test(keyId),
    "usage: sign-contract INPUT ROLE KEY_ID PRIVATE_KEY OUTPUT",
  );
  const envelope = readJson(input);
  validateReleaseShape(envelope.release);
  requireThat(
    envelope.schemaVersion === 2 &&
      envelope.qualification?.subjectSha256 ===
        sha256(canonical(envelope.release)),
    "qualification subject mismatch",
  );
  const key = createPrivateKey(fs.readFileSync(keyFile));
  requireThat(
    key.asymmetricKeyType === "ed25519",
    "Ed25519 signing key required",
  );
  const bytes = Buffer.from(
    canonical({
      schemaVersion: 2,
      release: envelope.release,
      qualification: envelope.qualification,
    }),
  );
  envelope.signatures = [
    ...(envelope.signatures ?? []).filter((s) => s.role !== role),
    { role, keyId, signature: sign(null, bytes, key).toString("base64") },
  ];
  fs.writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
