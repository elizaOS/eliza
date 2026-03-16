/**
 * Crypto module exports
 */

export {
  // Key derivation
  generateSalt,
  generateKey,
  deriveKeyPbkdf2,
  deriveKeyScrypt,
  deriveKeyFromAgentId,
  createKeyDerivationParams,

  // Encryption
  encrypt,
  encryptGcm,
  encryptCbc,

  // Decryption
  decrypt,
  decryptGcm,
  decryptCbc,

  // Utilities
  isEncryptedSecret,
  generateSecureToken,
  hashValue,
  secureCompare,

  // Key manager
  KeyManager,

  // Constants
  ALGORITHM_GCM,
  ALGORITHM_CBC,
  IV_LENGTH,
  KEY_LENGTH,
  DEFAULT_SALT_LENGTH,
  DEFAULT_PBKDF2_ITERATIONS,
} from "./encryption.js";
