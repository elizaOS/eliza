/**
 * Browser stub for Node.js 'crypto' module.
 * Uses the Web Crypto API where possible.
 */

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomUUID(): string {
  return crypto.randomUUID();
}

export function createHash(_algorithm: string): {
  update: (data: string | Uint8Array) => {
    digest: (encoding?: string) => string;
  };
} {
  throw new Error(
    "crypto.createHash is not available in browser - use Web Crypto API",
  );
}

export function createHmac(
  _algorithm: string,
  _key: string | Uint8Array,
): {
  update: (data: string | Uint8Array) => {
    digest: (encoding?: string) => string;
  };
} {
  throw new Error(
    "crypto.createHmac is not available in browser - use Web Crypto API",
  );
}

export function pbkdf2Sync(
  _password: string | Uint8Array,
  _salt: string | Uint8Array,
  _iterations: number,
  _keylen: number,
  _digest: string,
): Uint8Array {
  throw new Error(
    "crypto.pbkdf2Sync is not available in browser - use Web Crypto API",
  );
}

export const webcrypto = crypto;

export default {
  randomBytes,
  randomUUID,
  createHash,
  createHmac,
  pbkdf2Sync,
  webcrypto,
};
