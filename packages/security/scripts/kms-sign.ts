#!/usr/bin/env node
/**
 * kms-sign — tiny stdin/stdout CLI shim around `@elizaos/security`'s KMS.
 *
 * Used by Python publish flows (and any other non-Node caller) to sign a
 * blob without re-implementing key derivation. Reads raw bytes from stdin,
 * signs them with the system key for the requested purpose, and writes a
 * single-line JSON record to stdout:
 *
 *   { "sig": "<base64>", "key_id": "system:<purpose>/v1",
 *     "key_version": 1, "algorithm": "ed25519",
 *     "public_key": "<base64>" }
 *
 * Usage:
 *
 *   cat model.gguf | kms-sign --purpose model-artifact > model.gguf.sig.json
 *   kms-sign --purpose model-artifact --in model.gguf --out model.gguf.sig.json
 *
 * Local-only by default — uses the LocalKmsAdapter with a root key derived
 * from $ELIZA_KMS_PASSPHRASE (must be set in CI/dev). Production deployments
 * will swap this for the Steward HTTP adapter once Steward exposes the
 * `/v1/kms/keys/:key_id/sign` endpoint (see STEWARD-KMS-SPEC.md).
 *
 * SOC2 mapping: CC6.8 (artifact integrity), CC8.1 (change management).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { systemKey } from "../src/kms/key-namespace.js";
import { LocalKmsAdapter } from "../src/kms/local-adapter.js";

interface CliArgs {
  purpose: string;
  inputPath?: string;
  outputPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let purpose = "";
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--purpose") {
      purpose = argv[++i] ?? "";
    } else if (arg === "--in") {
      inputPath = argv[++i];
    } else if (arg === "--out") {
      outputPath = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "Usage: kms-sign --purpose <name> [--in path] [--out path]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!purpose) {
    throw new Error("--purpose is required (e.g. --purpose model-artifact)");
  }
  return { purpose, inputPath, outputPath };
}

function readInput(inputPath?: string): Uint8Array {
  if (inputPath) {
    return new Uint8Array(readFileSync(inputPath));
  }
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while ((chunk = process.stdin.read()) !== null) {
    chunks.push(chunk as Buffer);
  }
  // Fallback: blocking read via readFileSync of /dev/stdin
  if (chunks.length === 0) {
    try {
      return new Uint8Array(readFileSync(0));
    } catch {
      return new Uint8Array(0);
    }
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const passphrase = process.env.ELIZA_KMS_PASSPHRASE;
  if (!passphrase) {
    throw new Error(
      "ELIZA_KMS_PASSPHRASE must be set so the local KMS can derive a " +
        "root key. In production this is replaced by the Steward adapter.",
    );
  }
  const salt = process.env.ELIZA_KMS_SALT ?? "elizaos.kms.local.v1";
  const kms = LocalKmsAdapter.fromPassphrase(passphrase, salt);
  const keyId = systemKey(args.purpose);
  await kms.getOrCreateKey(keyId);

  const data = readInput(args.inputPath);
  if (data.length === 0) {
    throw new Error("refusing to sign empty input");
  }

  const result = await kms.sign(keyId, data, "ed25519");
  const publicKey = await kms.getPublicKey(keyId);

  const out = {
    sig: toBase64(result.signature),
    key_id: result.keyId,
    key_version: result.keyVersion,
    algorithm: result.algorithm,
    public_key: toBase64(publicKey),
  };
  const json = `${JSON.stringify(out)}\n`;
  if (args.outputPath) {
    writeFileSync(args.outputPath, json, "utf-8");
  } else {
    process.stdout.write(json);
  }
}

main().catch((err) => {
  process.stderr.write(`kms-sign: ${(err as Error).message}\n`);
  process.exit(1);
});
