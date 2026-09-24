/** Preserves the connector-token encryption API through its Node-only shared owner. */
export {
  decryptTokenEnvelope,
  type EncryptedTokenEnvelope,
  encryptTokenPayload,
  isEncryptedTokenEnvelope,
  resolveTokenEncryptionKey,
} from "@elizaos/plugin-health/crypto/token-encryption";
