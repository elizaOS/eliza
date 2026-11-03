import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const scrypt = promisify(scryptCb);

export interface KeystoreFile {
  version: 1;
  publicKey: string;
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

async function keyFromPassword(password: string, salt: Buffer): Promise<Buffer> {
  return (await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 })) as Buffer;
}

export async function encryptSecret(
  secret: string,
  password: string
): Promise<Omit<KeystoreFile, "version" | "publicKey">> {
  if (password.trim().length < 8) throw new Error("Password must be at least 8 characters.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await keyFromPassword(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export async function decryptSecret(file: KeystoreFile, password: string): Promise<string> {
  const key = await keyFromPassword(password, Buffer.from(file.salt, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64"));
  decipher.setAuthTag(Buffer.from(file.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(file.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

export function keystorePath(dataDir: string): string {
  return path.join(dataDir, "keystore.json");
}

export async function readKeystore(dataDir: string): Promise<KeystoreFile | null> {
  try {
    const raw = await readFile(keystorePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as KeystoreFile;
    if (parsed.version !== 1 || !parsed.publicKey || !parsed.ciphertext) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeKeystore(dataDir: string, file: KeystoreFile): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(keystorePath(dataDir), JSON.stringify(file), { mode: 0o600 });
}

export function secretFromKeypair(keypair: Keypair): string {
  return bs58.encode(keypair.secretKey);
}

export function keypairFromSecret(secret: string): Keypair {
  const bytes = bs58.decode(secret.trim());
  if (bytes.length !== 64) throw new Error("Expected a 64-byte base58 secret key.");
  return Keypair.fromSecretKey(bytes);
}

export async function createTradingKeystore(
  dataDir: string,
  password: string,
  secret?: string
): Promise<{ publicKey: string; backupOnce: string | null }> {
  const keypair = secret ? keypairFromSecret(secret) : Keypair.generate();
  const encoded = secretFromKeypair(keypair);
  const sealed = await encryptSecret(encoded, password);
  const file: KeystoreFile = { version: 1, publicKey: keypair.publicKey.toBase58(), ...sealed };
  await writeKeystore(dataDir, file);
  return { publicKey: file.publicKey, backupOnce: secret ? null : encoded };
}
