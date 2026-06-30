#!/usr/bin/env node
/**
 * kms-verify — companion to kms-sign.
 *
 * Verifies a signature over a blob using the same LocalKmsAdapter that
 * kms-sign uses. Reads the signature record (the JSON produced by
 * kms-sign) from --sig and the data from --in (or stdin).
 *
 * Exits 0 on valid, 1 on invalid, 2 on argument errors.
 */

import { readFileSync } from "node:fs";
import { LocalKmsAdapter } from "../src/kms/local-adapter.js";

interface CliArgs {
  sigPath: string;
  inputPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let sigPath = "";
  let inputPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sig") {
      sigPath = argv[++i] ?? "";
    } else if (arg === "--in") {
      inputPath = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: kms-verify --sig path [--in path]\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!sigPath) throw new Error("--sig is required");
  return { sigPath, inputPath };
}

function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const passphrase = process.env.ELIZA_KMS_PASSPHRASE;
  if (!passphrase) {
    throw new Error("ELIZA_KMS_PASSPHRASE must be set");
  }
  const salt = process.env.ELIZA_KMS_SALT ?? "elizaos.kms.local.v1";
  const kms = LocalKmsAdapter.fromPassphrase(passphrase, salt);

  const record = JSON.parse(readFileSync(args.sigPath, "utf-8")) as {
    sig: string;
    key_id: string;
    algorithm: "ed25519" | "rsa-pss-sha256";
  };
  const data = args.inputPath
    ? new Uint8Array(readFileSync(args.inputPath))
    : new Uint8Array(readFileSync(0));
  await kms.getOrCreateKey(record.key_id);
  const ok = await kms.verify(
    record.key_id,
    data,
    fromBase64(record.sig),
    record.algorithm,
  );
  if (ok) {
    process.stdout.write("verify OK\n");
    process.exit(0);
  }
  process.stderr.write("verify FAILED\n");
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`kms-verify: ${(err as Error).message}\n`);
  process.exit(2);
});
