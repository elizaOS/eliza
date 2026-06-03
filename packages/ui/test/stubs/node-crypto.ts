// Complete node:crypto stub for the Storybook browser catalog. Vite
// externalizes node builtins; core feature/secrets modules pulled via the
// @elizaos/shared barrel touch crypto at load. These paths never run during a
// story render. Key functions get browser-backed/benign behaviour; the rest are
// throwing stubs so every static named import resolves.

const webcrypto = (globalThis as { crypto?: Crypto }).crypto;
const notAvailable = (name: string) => {
  throw new Error(`node:crypto stub cannot ${name} in Storybook`);
};

class HashLike {
  update() {
    return this;
  }
  digest() {
    return "";
  }
}

export const constants = {};
export { webcrypto };

export const createHash = () => new HashLike();
export const createHmac = () => new HashLike();
export const randomBytes = (size = 0) =>
  new Uint8Array(typeof size === "number" ? size : 0);
export const randomFillSync = (buf: Uint8Array) => buf;
export const randomUUID = () =>
  webcrypto?.randomUUID?.() ?? "00000000-0000-0000-0000-000000000000";
export const timingSafeEqual = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
};

export const getRandomValues = <T extends ArrayBufferView | null>(buf: T): T =>
  (webcrypto?.getRandomValues?.(buf as never) as T) ?? buf;

export const Certificate = (...args: unknown[]) => notAvailable("Certificate");
export const Cipheriv = (...args: unknown[]) => notAvailable("Cipheriv");
export const Decipheriv = (...args: unknown[]) => notAvailable("Decipheriv");
export const DiffieHellman = (...args: unknown[]) =>
  notAvailable("DiffieHellman");
export const DiffieHellmanGroup = (...args: unknown[]) =>
  notAvailable("DiffieHellmanGroup");
export const ECDH = (...args: unknown[]) => notAvailable("ECDH");
export const Hash = (...args: unknown[]) => notAvailable("Hash");
export const Hmac = (...args: unknown[]) => notAvailable("Hmac");
export const KeyObject = (...args: unknown[]) => notAvailable("KeyObject");
export const Sign = (...args: unknown[]) => notAvailable("Sign");
export const Verify = (...args: unknown[]) => notAvailable("Verify");
export const X509Certificate = (...args: unknown[]) =>
  notAvailable("X509Certificate");
export const checkPrime = (...args: unknown[]) => notAvailable("checkPrime");
export const checkPrimeSync = (...args: unknown[]) =>
  notAvailable("checkPrimeSync");
export const createCipheriv = (...args: unknown[]) =>
  notAvailable("createCipheriv");
export const createDecipheriv = (...args: unknown[]) =>
  notAvailable("createDecipheriv");
export const createDiffieHellman = (...args: unknown[]) =>
  notAvailable("createDiffieHellman");
export const createDiffieHellmanGroup = (...args: unknown[]) =>
  notAvailable("createDiffieHellmanGroup");
export const createECDH = (...args: unknown[]) => notAvailable("createECDH");
export const createPrivateKey = (...args: unknown[]) =>
  notAvailable("createPrivateKey");
export const createPublicKey = (...args: unknown[]) =>
  notAvailable("createPublicKey");
export const createSecretKey = (...args: unknown[]) =>
  notAvailable("createSecretKey");
export const createSign = (...args: unknown[]) => notAvailable("createSign");
export const createVerify = (...args: unknown[]) =>
  notAvailable("createVerify");
export const diffieHellman = (...args: unknown[]) =>
  notAvailable("diffieHellman");
export const generateKey = (...args: unknown[]) => notAvailable("generateKey");
export const generateKeyPair = (...args: unknown[]) =>
  notAvailable("generateKeyPair");
export const generateKeyPairSync = (...args: unknown[]) =>
  notAvailable("generateKeyPairSync");
export const generateKeySync = (...args: unknown[]) =>
  notAvailable("generateKeySync");
export const generatePrime = (...args: unknown[]) =>
  notAvailable("generatePrime");
export const generatePrimeSync = (...args: unknown[]) =>
  notAvailable("generatePrimeSync");
export const getCipherInfo = (...args: unknown[]) =>
  notAvailable("getCipherInfo");
export const getCiphers = (...args: unknown[]) => notAvailable("getCiphers");
export const getCurves = (...args: unknown[]) => notAvailable("getCurves");
export const getDiffieHellman = (...args: unknown[]) =>
  notAvailable("getDiffieHellman");
export const getFips = (...args: unknown[]) => notAvailable("getFips");
export const getHashes = (...args: unknown[]) => notAvailable("getHashes");
export const hash = (...args: unknown[]) => notAvailable("hash");
export const hkdf = (...args: unknown[]) => notAvailable("hkdf");
export const hkdfSync = (...args: unknown[]) => notAvailable("hkdfSync");
export const pbkdf2 = (...args: unknown[]) => notAvailable("pbkdf2");
export const pbkdf2Sync = (...args: unknown[]) => notAvailable("pbkdf2Sync");
export const privateDecrypt = (...args: unknown[]) =>
  notAvailable("privateDecrypt");
export const privateEncrypt = (...args: unknown[]) =>
  notAvailable("privateEncrypt");
export const publicDecrypt = (...args: unknown[]) =>
  notAvailable("publicDecrypt");
export const publicEncrypt = (...args: unknown[]) =>
  notAvailable("publicEncrypt");
export const randomFill = (...args: unknown[]) => notAvailable("randomFill");
export const randomInt = (...args: unknown[]) => notAvailable("randomInt");
export const scrypt = (...args: unknown[]) => notAvailable("scrypt");
export const scryptSync = (...args: unknown[]) => notAvailable("scryptSync");
export const secureHeapUsed = (...args: unknown[]) =>
  notAvailable("secureHeapUsed");
export const setEngine = (...args: unknown[]) => notAvailable("setEngine");
export const setFips = (...args: unknown[]) => notAvailable("setFips");
export const sign = (...args: unknown[]) => notAvailable("sign");
export const verify = (...args: unknown[]) => notAvailable("verify");

export default {
  Certificate,
  Cipheriv,
  Decipheriv,
  DiffieHellman,
  DiffieHellmanGroup,
  ECDH,
  Hash,
  Hmac,
  KeyObject,
  Sign,
  Verify,
  X509Certificate,
  checkPrime,
  checkPrimeSync,
  constants,
  createCipheriv,
  createDecipheriv,
  createDiffieHellman,
  createDiffieHellmanGroup,
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  createSign,
  createVerify,
  diffieHellman,
  generateKey,
  generateKeyPair,
  generateKeyPairSync,
  generateKeySync,
  generatePrime,
  generatePrimeSync,
  getCipherInfo,
  getCiphers,
  getCurves,
  getDiffieHellman,
  getFips,
  getHashes,
  getRandomValues,
  hash,
  hkdf,
  hkdfSync,
  pbkdf2,
  pbkdf2Sync,
  privateDecrypt,
  privateEncrypt,
  publicDecrypt,
  publicEncrypt,
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
  scrypt,
  scryptSync,
  secureHeapUsed,
  setEngine,
  setFips,
  sign,
  timingSafeEqual,
  verify,
  webcrypto,
};
