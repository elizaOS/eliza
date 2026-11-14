#!/usr/bin/env node
/**
 * Offline key-ceremony generator for every key in a signing key manifest
 * (default: android/signing/key-manifest.json; products pass --manifest with
 * their own application keys added).
 *
 *   node packages/os/scripts/android/generate-release-keys.ts \
 *     --output /media/CEREMONY/keys --passphrase-file /dev/shm/ceremony/pass \
 *     --organization "Example Inc" [--manifest FILE] [--only a,b]
 *
 * Writes into a NEW directory outside any Git working tree:
 *   <name>.x509.pem + <name>.pk8.enc   x509-pk8 keys (AOSP make_key layout;
 *                                       private key is scrypt/AES-256 PKCS#8 DER)
 *   <name>.pem.enc + <name>.avbpubkey  avb-rsa keys (`avb` also gets avb_pkmd.bin)
 *   <name>.pem.enc + <name>.pub.pem    ed25519 keys
 *   fingerprints.json                   public fingerprints for review/enrollment
 * Unencrypted private keys exist only in memory and in the openssl pipes.
 * --test-keys makes small, clearly labelled keys for tests; never ship them.
 */
import { spawnSync } from "node:child_process";
import crypto, { type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const elizaRepositoryRoot = fileURLToPath(
  new URL("../../../..", import.meta.url),
);
export const defaultKeyManifest = fileURLToPath(
  new URL("../../android/signing/key-manifest.json", import.meta.url),
);

export type KeyKind = "x509-pk8" | "avb-rsa" | "ed25519";
export interface ManifestKey {
  name: string;
  kind: KeyKind;
  bits?: number;
  consumer: string;
  storage: string;
  rotatable: boolean | string;
}
export interface KeyManifest {
  schemaVersion: 1;
  reviewedAt: string;
  keys: ManifestKey[];
}
export interface GenerateOptions {
  output: string;
  passphraseFile: string;
  organization: string;
  manifest: string;
  testKeys: boolean;
  only?: string;
}

const keyKinds = new Set(["x509-pk8", "avb-rsa", "ed25519"]);
const storageKinds = new Set(["offline-encrypted", "hsm", "cloud-hsm"]);
const keyNamePattern = /^[a-z][a-z0-9_]{0,62}$/;

export function parseArgs(argv: string[]): GenerateOptions {
  const args: Record<string, string | boolean> = {
    testKeys: false,
    manifest: defaultKeyManifest,
  };
  const valued = [
    "--output",
    "--passphrase-file",
    "--organization",
    "--manifest",
    "--only",
  ];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--test-keys") args.testKeys = true;
    else if (valued.includes(arg)) {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      args[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] =
        argv[++i];
    } else throw new Error(`Unknown argument ${arg}`);
  }
  if (!args.output)
    throw new Error("Supply --output NEW_DIRECTORY outside any Git checkout.");
  if (!args.passphraseFile)
    throw new Error("Supply --passphrase-file FILE (mode 0600).");
  if (args.testKeys && args.organization === undefined)
    args.organization = "Test Keys";
  if (typeof args.organization !== "string")
    throw new Error("Supply --organization for release keys.");
  if (!/^[\w .,&'-]{1,64}$/.test(args.organization))
    throw new Error("--organization must be 1-64 plain characters.");
  return args as unknown as GenerateOptions;
}

export function loadKeyManifest(file: string): KeyManifest {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.keys))
    throw new Error(`${file}: expected schemaVersion 1 with a keys array`);
  const names = new Set<string>();
  for (const key of manifest.keys) {
    if (!keyNamePattern.test(key?.name ?? ""))
      throw new Error(`${file}: invalid key name ${JSON.stringify(key?.name)}`);
    if (names.has(key.name))
      throw new Error(`${file}: duplicate key ${key.name}`);
    names.add(key.name);
    if (!keyKinds.has(key.kind))
      throw new Error(`${file}: ${key.name} has unknown kind ${key.kind}`);
    if (!storageKinds.has(key.storage))
      throw new Error(
        `${file}: ${key.name} has unknown storage ${key.storage}`,
      );
    if (key.kind !== "ed25519" && ![4096, 8192].includes(key.bits))
      throw new Error(`${file}: ${key.name} must be RSA-4096 or RSA-8192`);
  }
  return manifest;
}

// AVB public key format, byte-for-byte with avbtool's AvbRSAPublicKey.encode():
// be32 num_bits, be32 n0inv = 2^32 - n^-1 mod 2^32, modulus, R^2 mod n where
// R = 2^bit_length(n); both big integers are num_bits/8 bytes big-endian.
export function encodeAvbPublicKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "RSA" || jwk.e !== "AQAB" || !jwk.n)
    throw new Error("AVB keys must be RSA with exponent 65537");
  const n = BigInt(`0x${Buffer.from(jwk.n, "base64url").toString("hex")}`);
  const numBits = n.toString(2).length;
  if (![2048, 4096, 8192].includes(numBits))
    throw new Error(`Unsupported AVB key size ${numBits}`);
  const b = 1n << 32n;
  const n0inv = b - modInverse(n % b, b);
  const r = 1n << BigInt(numBits);
  const rrModN = (r * r) % n;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(numBits, 0);
  header.writeUInt32BE(Number(n0inv), 4);
  return Buffer.concat([
    header,
    bigToBytes(n, numBits / 8),
    bigToBytes(rrModN, numBits / 8),
  ]);
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a, m];
  let [oldS, s] = [1n, 0n];
  while (r) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("modulus is not invertible");
  return ((oldS % m) + m) % m;
}

function bigToBytes(value: bigint, length: number): Buffer {
  const hex = value.toString(16).padStart(length * 2, "0");
  if (hex.length > length * 2) throw new Error("value too large");
  return Buffer.from(hex, "hex");
}

// Placeholder for the plaintext key argument. openssl cannot open /dev/stdin
// when Node supplies a socket (Linux CI), and `req -key` has no stdin form, so
// the key passes through a 0600 file in a fresh 0700 directory that is
// overwritten and removed as soon as openssl exits.
const KEY_INPUT = "<private-key-input>";

function openssl(args: string[], input: string | Buffer): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-key-"));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "key.pem");
  const bytes = Buffer.from(input);
  try {
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
    const result = spawnSync(
      "openssl",
      args.map((arg) => (arg === KEY_INPUT ? file : arg)),
      { maxBuffer: 16 * 1024 ** 2 },
    );
    if (result.error)
      throw new Error(`openssl unavailable: ${result.error.message}`);
    if (result.status !== 0)
      throw new Error(
        `openssl ${args[0]} failed: ${result.stderr.toString().trim()}`,
      );
    return result.stdout;
  } finally {
    if (fs.existsSync(file)) fs.writeFileSync(file, Buffer.alloc(bytes.length));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function enclosingGitWorkTree(target: string): string | null {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  current = fs.realpathSync(current);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Key material must never land in this repository or in any other Git working
 * tree (for example a downstream product that vendors this checkout), where a
 * stray `git add` could publish it.
 */
export function assertSafeKeyOutput(target: string, what: string): string {
  const resolved = path.resolve(target);
  const relative = path.relative(elizaRepositoryRoot, resolved);
  if (!relative.startsWith("..") && !path.isAbsolute(relative))
    throw new Error(
      `Refusing to write ${what} inside the eliza repository (${resolved}).`,
    );
  const workTree = enclosingGitWorkTree(resolved);
  if (workTree)
    throw new Error(
      `Refusing to write ${what} inside the Git working tree ${workTree}.`,
    );
  if (fs.existsSync(resolved))
    throw new Error(
      `Output ${resolved} already exists; use a new empty directory.`,
    );
  return resolved;
}

export function readPassphraseFile(file: string): string {
  const stat = fs.statSync(file);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    throw new Error(`${file} must not be readable by group/other (chmod 600).`);
  const passphrase = fs.readFileSync(file, "utf8").split(/\r?\n/)[0];
  if (passphrase.trim().length < 20)
    throw new Error("Passphrase must be at least 20 characters.");
  return passphrase;
}

function writePrivate(file: string, data: Buffer) {
  fs.writeFileSync(file, data, { mode: 0o600, flag: "wx" });
}

// PBES2 with the scrypt KDF and AES-256-CBC. decrypt-release-keys.ts writes the
// plaintext AOSP layout to tmpfs in the signing environment.
function encryptPkcs8(
  privatePem: string,
  passFile: string,
  outform: "PEM" | "DER",
): Buffer {
  return openssl(
    [
      "pkcs8",
      "-topk8",
      "-in",
      KEY_INPUT,
      "-outform",
      outform,
      "-v2",
      "aes-256-cbc",
      "-scrypt",
      "-passout",
      `file:${passFile}`,
    ],
    privatePem,
  );
}

const sha256 = (data: Buffer | string) =>
  crypto.createHash("sha256").update(data).digest("hex");

export function generate(options: GenerateOptions) {
  const output = assertSafeKeyOutput(options.output, "keys");
  readPassphraseFile(options.passphraseFile);
  const manifest = loadKeyManifest(options.manifest);
  const only = options.only ? new Set(options.only.split(",")) : null;
  const keys = manifest.keys.filter((k) => !only || only.has(k.name));
  if (!keys.length) throw new Error("No keys selected.");
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  if (options.testKeys)
    fs.writeFileSync(
      path.join(output, "TEST-KEYS-DO-NOT-SHIP"),
      "Generated with --test-keys.\n",
    );
  const fingerprints = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    testKeys: options.testKeys,
    organization: options.organization,
    manifestReviewedAt: manifest.reviewedAt,
    keys: [] as Record<string, unknown>[],
  };
  for (const key of keys) {
    const label = options.testKeys ? `TEST-ONLY ${key.name}` : key.name;
    const entry: Record<string, unknown> = {
      name: key.name,
      kind: key.kind,
      storage: key.storage,
    };
    const base = path.join(output, key.name);
    if (key.kind === "ed25519") {
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
      const pem = privateKey.export({ type: "pkcs8", format: "pem" });
      writePrivate(
        `${base}.pem.enc`,
        encryptPkcs8(pem as string, options.passphraseFile, "PEM"),
      );
      const publicPem = publicKey.export({ type: "spki", format: "pem" });
      fs.writeFileSync(`${base}.pub.pem`, publicPem);
      const spki = publicKey.export({ type: "spki", format: "der" });
      // Same encodings as scripts/release-key-policy.ts expects in
      // ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_{BASE64,SHA256}, and the PEM
      // that android/release-trust.json `publicKey` accepts.
      entry.spkiBase64 = spki.toString("base64");
      entry.spkiSha256 = sha256(spki);
      entry.publicKeyPem = publicPem;
    } else {
      const bits = options.testKeys ? 2048 : (key.bits as number);
      const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: bits,
        publicExponent: 65537,
      });
      const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
      entry.bits = bits;
      if (key.kind === "x509-pk8") {
        const subject = `/C=US/O=${options.organization}/OU=${options.testKeys ? "TEST ONLY" : "Release"}/CN=${label}`;
        const cert = openssl(
          [
            "req",
            "-new",
            "-x509",
            "-sha256",
            "-key",
            KEY_INPUT,
            "-days",
            "10950",
            "-subj",
            subject,
          ],
          pem,
        );
        fs.writeFileSync(`${base}.x509.pem`, cert);
        writePrivate(
          `${base}.pk8.enc`,
          encryptPkcs8(pem, options.passphraseFile, "DER"),
        );
        const x509 = new crypto.X509Certificate(cert);
        if (!x509.publicKey.equals(publicKey))
          throw new Error(`${key.name}: certificate does not match key`);
        entry.certificateSha256 = x509.fingerprint256
          .replaceAll(":", "")
          .toLowerCase();
        entry.subject = x509.subject.replace(/\n/g, ", ");
      } else {
        writePrivate(
          `${base}.pem.enc`,
          encryptPkcs8(pem, options.passphraseFile, "PEM"),
        );
        const avb = encodeAvbPublicKey(publicKey);
        fs.writeFileSync(`${base}.avbpubkey`, avb);
        if (key.name === "avb")
          fs.writeFileSync(path.join(output, "avb_pkmd.bin"), avb);
        entry.avbPublicKeySha256 = sha256(avb);
        fs.writeFileSync(
          `${base}.pub.pem`,
          publicKey.export({ type: "spki", format: "pem" }),
        );
      }
    }
    fingerprints.keys.push(entry);
  }
  fs.writeFileSync(
    path.join(output, "fingerprints.json"),
    `${JSON.stringify(fingerprints, null, 2)}\n`,
  );
  return { output, fingerprints };
}

if (import.meta.main) {
  try {
    const { output, fingerprints } = generate(parseArgs(process.argv.slice(2)));
    console.log(
      `Generated ${fingerprints.keys.length} keys in ${output}${fingerprints.testKeys ? " (TEST KEYS)" : ""}.`,
    );
    console.log(
      "Review fingerprints.json, then follow packages/os/android/signing/README.md.",
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
