import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'crypto';

export type WalletRecord = {
  name: string;
  publicKey: string;
  path: string;
};

/**
 * Resolved lazily (not cached at module load) so tests can override via
 * CLAWD_WALLET_DIR, and so a HOME change mid-process (rare, but real in
 * multi-tenant hosts) is always honored.
 */
function getWalletDir(): string {
  return process.env.CLAWD_WALLET_DIR || join(homedir(), '.clawd-code', 'wallets');
}

function ensureWalletDir(): string {
  const dir = getWalletDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function walletPath(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '-');
  return join(getWalletDir(), `${safeName}.json`);
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  return Uint8Array.from(Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base58Encode(bytes: Uint8Array): string {
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

export function loadWalletKeypair(name = 'default'): WalletRecord & { secretKey: number[] } {
  const path = walletPath(name);
  if (!existsSync(path)) {
    throw new Error(`Wallet not found: ${path}`);
  }

  const secret = Uint8Array.from(JSON.parse(readFileSync(path, 'utf-8')));
  const keypair = keypairFromSecret(secret);
  return {
    name,
    publicKey: keypair.publicKey,
    secretKey: keypair.secretKey,
    path,
  };
}

export function signWalletMessage(name: string, message: string): { wallet: string; message: string; signature: string } {
  const keypair = loadWalletKeypair(name);
  const secret = Uint8Array.from(keypair.secretKey);
  const seed = secret.slice(0, 32);
  const publicKey = secret.slice(32);
  const privateKey = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: bytesToBase64Url(seed),
      x: bytesToBase64Url(publicKey),
    },
  });
  const signature = cryptoSign(null, Buffer.from(message), privateKey);
  return {
    wallet: keypair.publicKey,
    message,
    signature: base58Encode(signature),
  };
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
  const dir = ensureWalletDir();

  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const path = join(dir, file);
      const secret = Uint8Array.from(JSON.parse(readFileSync(path, 'utf-8')));
      const keypair = keypairFromSecret(secret);

      return {
        name: file.replace(/\.json$/, ''),
        publicKey: keypair.publicKey,
        path,
      };
    });
}
