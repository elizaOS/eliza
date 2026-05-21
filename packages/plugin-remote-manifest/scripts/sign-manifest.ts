#!/usr/bin/env bun
/**
 * sign-manifest — operator CLI for stamping a plugin tarball with an
 * Ed25519 signature compatible with `verifyPluginArtifact`.
 *
 * Usage:
 *   bun run packages/plugin-remote-manifest/scripts/sign-manifest.ts \
 *     --tarball ./my-plugin-1.2.3.tgz \
 *     [--signer ops@example.com] \
 *     [--out ./my-plugin-1.2.3.tgz.sig.json]
 *
 * Environment:
 *   ELIZA_KMS_BACKEND   memory | local | steward (defaults to local for CLI)
 *   ELIZA_LOCAL_MODE    1 to force local KMS
 *
 * The CLI computes SHA-256 over the tarball, signs the hash with
 * `system:plugin-manifest/v1`, and emits a JSON sidecar of the form:
 *
 *   { "hash": "<hex>", "signature": "<base64>", "signer": "<label?>" }
 *
 * Operators commit this sidecar to their release pipeline; the runtime
 * verifier consumes it via the artifact source's signature field.
 *
 * This is a stub — production release flows will integrate with Steward
 * for the actual signing operation. The shape of the sidecar is stable.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createKmsClient, systemKey } from "@elizaos/security";
import { sha256File } from "../src/signature.js";

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const tarball = arg("--tarball");
  if (!tarball) {
    process.stderr.write(
      "Usage: sign-manifest --tarball <path> [--signer <label>] [--out <path>]\n",
    );
    process.exit(2);
  }
  const signer = arg("--signer");
  const out = arg("--out") ?? `${tarball}.sig.json`;

  const kms = createKmsClient();
  const keyId = systemKey("plugin-manifest");
  await kms.getOrCreateKey(keyId);

  const hashHex = (await sha256File(resolve(tarball))).toLowerCase();
  const hashBytes = new Uint8Array(hashHex.length / 2);
  for (let i = 0; i < hashBytes.length; i++) {
    hashBytes[i] = Number.parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
  }
  const { signature } = await kms.sign(keyId, hashBytes, "ed25519");
  const sigB64 = Buffer.from(signature).toString("base64");

  const payload = {
    hash: hashHex,
    signature: sigB64,
    ...(signer ? { signer } : {}),
  };
  await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`signed: ${tarball} -> ${out}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `sign-manifest failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
