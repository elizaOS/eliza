import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { generateKeyPairSync } from 'crypto';

const WALLET_DIR = join(homedir(), '.clawd-code', 'wallets');

export type WalletRecord = {
  name: string;
  publicKey: string;
  path: string;
};

function ensureWalletDir(): void {
  mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  chmodSync(WALLET_DIR, 0o700);
}

function walletPath(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '-');
  return join(WALLET_DIR, `${safeName}.json`);
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  return Uint8Array.from(Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

function base58Encode(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = [0];

  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  for (const byte of bytes) {
    if (byte === 0) digits.push(0);
    else break;
  }

  return digits.reverse().map((digit) => alphabet[digit]).join('');
}

function keypairFromSecret(secret: Uint8Array): { publicKey: string; secretKey: number[] } {
  if (secret.length !== 64) {
    throw new Error('Expected Solana keypair secret to contain 64 bytes');
  }

  return {
    publicKey: base58Encode(secret.slice(32)),
    secretKey: Array.from(secret),
  };
}

function generateSolanaKeypair(): { publicKey: string; secretKey: number[] } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (!jwk.d || !jwk.x) {
    throw new Error('Unable to export generated Ed25519 keypair');
  }

  const seed = base64UrlToBytes(jwk.d);
  const publicKey = base64UrlToBytes(jwk.x);
  return {
    publicKey: base58Encode(publicKey),
    secretKey: Array.from([...seed, ...publicKey]),
  };
}

export function createWallet(name = 'default'): WalletRecord {
  ensureWalletDir();

  const path = walletPath(name);
  if (existsSync(path)) {
    throw new Error(`Wallet already exists: ${path}`);
  }

  const keypair = generateSolanaKeypair();
  writeFileSync(path, JSON.stringify(keypair.secretKey));
  chmodSync(path, 0o600);

  return {
    name,
    publicKey: keypair.publicKey,
    path,
  };
}

export function listWallets(): WalletRecord[] {
  ensureWalletDir();

  return readdirSync(WALLET_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const path = join(WALLET_DIR, file);
      const secret = Uint8Array.from(JSON.parse(readFileSync(path, 'utf-8')));
      const keypair = keypairFromSecret(secret);

      return {
        name: file.replace(/\.json$/, ''),
        publicKey: keypair.publicKey,
        path,
      };
    });
}
