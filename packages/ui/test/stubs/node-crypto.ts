// Complete node:crypto shim for the Storybook browser catalog. Vite
// externalizes node builtins; core feature/secrets modules pulled via the
// @elizaos/shared barrel touch crypto at load. These paths never run during a
// story render. Key functions get browser-backed/benign behaviour; the rest are
// throwing shims so every static named import resolves.

const webcrypto = (globalThis as { crypto?: Crypto }).crypto;
const notAvailable = (name: string) => {
  throw new Error(`node:crypto browser shim cannot ${name} in Storybook`);
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

export const Certificate = (..._args: unknown[]) => notAvailable("Certificate");
export const Cipheriv = (..._args: unknown[]) => notAvailable("Cipheriv");
export const Decipheriv = (..._args: unknown[]) => notAvailable("Decipheriv");
export const DiffieHellman = (..._args: unknown[]) =>
  notAvailable("DiffieHellman");
export const DiffieHellmanGroup = (..._args: unknown[]) =>
  notAvailable("DiffieHellmanGroup");
export const ECDH = (..._args: unknown[]) => notAvailable("ECDH");
export const Hash = (..._args: unknown[]) => notAvailable("Hash");
export const Hmac = (..._args: unknown[]) => notAvailable("Hmac");
export const KeyObject = (..._args: unknown[]) => notAvailable("KeyObject");
export const Sign = (..._args: unknown[]) => notAvailable("Sign");
export const Verify = (..._args: unknown[]) => notAvailable("Verify");
export const X509Certificate = (..._args: unknown[]) =>
  notAvailable("X509Certificate");
export const checkPrime = (..._args: unknown[]) => notAvailable("checkPrime");
export const checkPrimeSync = (..._args: unknown[]) =>
  notAvailable("checkPrimeSync");
export const createCipheriv = (..._args: unknown[]) =>
  notAvailable("createCipheriv");
export const createDecipheriv = (..._args: unknown[]) =>
  notAvailable("createDecipheriv");
export const createDiffieHellman = (..._args: unknown[]) =>
  notAvailable("createDiffieHellman");
export const createDiffieHellmanGroup = (..._args: unknown[]) =>
  notAvailable("createDiffieHellmanGroup");
export const createECDH = (..._args: unknown[]) => notAvailable("createECDH");
export const createPrivateKey = (..._args: unknown[]) =>
  notAvailable("createPrivateKey");
export const createPublicKey = (..._args: unknown[]) =>
  notAvailable("createPublicKey");
export const createSecretKey = (..._args: unknown[]) =>
  notAvailable("createSecretKey");
export const createSign = (..._args: unknown[]) => notAvailable("createSign");
export const createVerify = (..._args: unknown[]) =>
  notAvailable("createVerify");
export const diffieHellman = (..._args: unknown[]) =>
  notAvailable("diffieHellman");
export const generateKey = (..._args: unknown[]) => notAvailable("generateKey");
export const generateKeyPair = (..._args: unknown[]) =>
  notAvailable("generateKeyPair");
export const generateKeyPairSync = (..._args: unknown[]) =>
  notAvailable("generateKeyPairSync");
export const generateKeySync = (..._args: unknown[]) =>
  notAvailable("generateKeySync");
export const generatePrime = (..._args: unknown[]) =>
  notAvailable("generatePrime");
export const generatePrimeSync = (..._args: unknown[]) =>
  notAvailable("generatePrimeSync");
export const getCipherInfo = (..._args: unknown[]) =>
  notAvailable("getCipherInfo");
export const getCiphers = (..._args: unknown[]) => notAvailable("getCiphers");
export const getCurves = (..._args: unknown[]) => notAvailable("getCurves");
export const getDiffieHellman = (..._args: unknown[]) =>
  notAvailable("getDiffieHellman");
export const getFips = (..._args: unknown[]) => notAvailable("getFips");
export const getHashes = (..._args: unknown[]) => notAvailable("getHashes");
export const hash = (..._args: unknown[]) => notAvailable("hash");
export const hkdf = (..._args: unknown[]) => notAvailable("hkdf");
export const hkdfSync = (..._args: unknown[]) => notAvailable("hkdfSync");
export const pbkdf2 = (..._args: unknown[]) => notAvailable("pbkdf2");
export const pbkdf2Sync = (..._args: unknown[]) => notAvailable("pbkdf2Sync");
export const privateDecrypt = (..._args: unknown[]) =>
  notAvailable("privateDecrypt");
export const privateEncrypt = (..._args: unknown[]) =>
  notAvailable("privateEncrypt");
export const publicDecrypt = (..._args: unknown[]) =>
  notAvailable("publicDecrypt");
export const publicEncrypt = (..._args: unknown[]) =>
  notAvailable("publicEncrypt");
export const randomFill = (..._args: unknown[]) => notAvailable("randomFill");
export const randomInt = (..._args: unknown[]) => notAvailable("randomInt");
export const scrypt = (..._args: unknown[]) => notAvailable("scrypt");
export const scryptSync = (..._args: unknown[]) => notAvailable("scryptSync");
export const secureHeapUsed = (..._args: unknown[]) =>
  notAvailable("secureHeapUsed");
export const setEngine = (..._args: unknown[]) => notAvailable("setEngine");
export const setFips = (..._args: unknown[]) => notAvailable("setFips");
export const sign = (..._args: unknown[]) => notAvailable("sign");
export const verify = (..._args: unknown[]) => notAvailable("verify");

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
