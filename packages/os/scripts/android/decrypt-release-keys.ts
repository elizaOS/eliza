#!/usr/bin/env node
/**
 * Signing-environment companion to generate-release-keys.ts.
 *
 *   node packages/os/scripts/android/decrypt-release-keys.ts --input KEYS_DIR \
 *     --output /dev/shm/keys --passphrase-file PASS [--only releasekey,platform]
 *
 * Writes the plaintext layout AOSP release tools expect into a NEW directory
 * that should live on tmpfs and be wiped after signing:
 *   <name>.pk8 (unencrypted PKCS#8 DER, as signapk requires) + <name>.x509.pem
 *   <name>.pem (PKCS#8 PEM, for avbtool, APEX payloads and Ed25519 signing)
 * Public files and fingerprints.json are copied so the result is one key dir.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertSafeKeyOutput,
  readPassphraseFile,
} from "./generate-release-keys.ts";

export interface DecryptOptions {
  input: string;
  output: string;
  passphraseFile: string;
  only?: string;
}

export function parseArgs(argv: string[]): DecryptOptions {
  const args: Record<string, string> = {};
  const usage =
    "Use --input DIR --output NEW_DIR --passphrase-file FILE [--only a,b]";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (
      !["--input", "--output", "--passphrase-file", "--only"].includes(arg) ||
      argv[i + 1] === undefined
    )
      throw new Error(usage);
    args[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] =
      argv[++i];
  }
  if (!args.input || !args.output || !args.passphraseFile)
    throw new Error("--input, --output and --passphrase-file are required");
  return args as unknown as DecryptOptions;
}

const fingerprint = (cert: crypto.X509Certificate) =>
  cert.fingerprint256.replaceAll(":", "").toLowerCase();

export function decrypt({
  input,
  output,
  passphraseFile,
  only,
}: DecryptOptions) {
  const target = assertSafeKeyOutput(output, "plaintext keys");
  const passphrase = readPassphraseFile(passphraseFile);
  const fingerprints = JSON.parse(
    fs.readFileSync(path.join(input, "fingerprints.json"), "utf8"),
  );
  const known = new Set<string>();
  for (const entry of fingerprints.keys) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(entry?.name ?? ""))
      throw new Error(`fingerprints.json has an invalid key name`);
    known.add(entry.name);
  }
  const selected = only === undefined ? null : new Set(only.split(","));
  // A misspelled or empty --only name must not "succeed" by decrypting nothing.
  for (const name of selected ?? [])
    if (!known.has(name))
      throw new Error(
        `--only names a key that is not in fingerprints.json: ${name || "(empty)"}`,
      );
  fs.mkdirSync(target, { mode: 0o700 });
  const written: string[] = [];
  for (const entry of fingerprints.keys) {
    if (selected && !selected.has(entry.name)) continue;
    const from = (suffix: string) => path.join(input, `${entry.name}${suffix}`);
    const to = (suffix: string) => path.join(target, `${entry.name}${suffix}`);
    if (entry.kind === "x509-pk8") {
      const key = crypto.createPrivateKey({
        key: fs.readFileSync(from(".pk8.enc")),
        format: "der",
        type: "pkcs8",
        passphrase,
      });
      const certPem = fs.readFileSync(from(".x509.pem"));
      const cert = new crypto.X509Certificate(certPem);
      if (!cert.checkPrivateKey(key))
        throw new Error(
          `${entry.name}: private key does not match certificate`,
        );
      if (fingerprint(cert) !== entry.certificateSha256)
        throw new Error(
          `${entry.name}: certificate fingerprint differs from fingerprints.json`,
        );
      fs.writeFileSync(
        to(".pk8"),
        key.export({ type: "pkcs8", format: "der" }),
        { mode: 0o600, flag: "wx" },
      );
      fs.writeFileSync(to(".x509.pem"), certPem);
    } else if (entry.kind === "avb-rsa" || entry.kind === "ed25519") {
      const key = crypto.createPrivateKey({
        key: fs.readFileSync(from(".pem.enc")),
        format: "pem",
        passphrase,
      });
      const expected = crypto.createPublicKey(
        fs.readFileSync(from(".pub.pem")),
      );
      if (!crypto.createPublicKey(key).equals(expected))
        throw new Error(`${entry.name}: private key does not match public key`);
      fs.writeFileSync(
        to(".pem"),
        key.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600, flag: "wx" },
      );
      const publicFiles = [`${entry.name}.pub.pem`, `${entry.name}.avbpubkey`];
      if (entry.name === "avb") publicFiles.push("avb_pkmd.bin");
      for (const file of publicFiles)
        if (fs.existsSync(path.join(input, file)))
          fs.copyFileSync(path.join(input, file), path.join(target, file));
    } else throw new Error(`${entry.name}: unknown key kind ${entry.kind}`);
    written.push(entry.name);
  }
  fs.copyFileSync(
    path.join(input, "fingerprints.json"),
    path.join(target, "fingerprints.json"),
  );
  return { target, written, testKeys: fingerprints.testKeys === true };
}

if (import.meta.main) {
  try {
    const { target, written, testKeys } = decrypt(
      parseArgs(process.argv.slice(2)),
    );
    console.log(
      `Decrypted ${written.length} keys into ${target}${testKeys ? " (TEST KEYS)" : ""}. Wipe it after signing.`,
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
