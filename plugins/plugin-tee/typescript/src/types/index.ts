/**
 * Core types for the TEE (Trusted Execution Environment) plugin.
 *
 * All types are strongly typed with explicit field requirements.
 * No `any` or `unknown` types.
 */

/**
 * TEE operation mode.
 */
export enum TeeMode {
  /** Local development with simulator at localhost:8090 */
  LOCAL = "LOCAL",
  /** Docker development with simulator at host.docker.internal:8090 */
  DOCKER = "DOCKER",
  /** Production mode without simulator */
  PRODUCTION = "PRODUCTION",
}

/**
 * TEE vendor names.
 */
export enum TeeVendor {
  /** Phala Network TEE */
  PHALA = "phala",
}

/**
 * TEE type (SGX, TDX, etc.)
 */
export enum TeeType {
  /** Intel SGX with Gramine */
  SGX_GRAMINE = "sgx_gramine",
  /** Intel TDX with DStack */
  TDX_DSTACK = "tdx_dstack",
}

/**
 * Remote attestation quote.
 */
export interface RemoteAttestationQuote {
  /** The attestation quote (hex-encoded) */
  readonly quote: string;
  /** Timestamp when the quote was generated */
  readonly timestamp: number;
}

/**
 * Data included in derive key attestation.
 */
export interface DeriveKeyAttestationData {
  /** Agent ID that derived the key */
  readonly agentId: string;
  /** Public key derived */
  readonly publicKey: string;
  /** Subject used for derivation */
  readonly subject?: string;
}

/**
 * Message to be attested.
 */
export interface RemoteAttestationMessage {
  /** Agent ID generating attestation */
  readonly agentId: string;
  /** Timestamp of attestation request */
  readonly timestamp: number;
  /** Message details */
  readonly message: {
    /** Entity ID in the message */
    readonly entityId: string;
    /** Room ID where message was sent */
    readonly roomId: string;
    /** Message content */
    readonly content: string;
  };
}

/**
 * Result of key derivation.
 */
export interface DeriveKeyResult {
  /** The derived key as bytes */
  readonly key: Uint8Array;
  /** Certificate chain for verification */
  readonly certificateChain: string[];
}

/**
 * Ed25519 keypair result from TEE.
 */
export interface Ed25519KeypairResult {
  /** The derived keypair */
  readonly publicKey: string;
  /** Secret key (32 bytes) */
  readonly secretKey: Uint8Array;
  /** Attestation quote for verification */
  readonly attestation: RemoteAttestationQuote;
}

/**
 * ECDSA (secp256k1) keypair result from TEE.
 */
export interface EcdsaKeypairResult {
  /** The derived address (0x prefixed) */
  readonly address: string;
  /** Private key (32 bytes) */
  readonly privateKey: Uint8Array;
  /** Attestation quote for verification */
  readonly attestation: RemoteAttestationQuote;
}

/**
 * TEE Service configuration.
 */
export interface TeeServiceConfig {
  /** TEE operation mode */
  readonly mode: TeeMode;
  /** TEE vendor to use */
  readonly vendor: TeeVendor;
  /** Secret salt for key derivation */
  readonly secretSalt?: string;
}

/**
 * Provider result returned by TEE providers.
 */
export interface TeeProviderResult {
  /** Data object with key information */
  readonly data: Record<string, string> | null;
  /** Values for template injection */
  readonly values: Record<string, string>;
  /** Human-readable text description */
  readonly text: string;
}

/**
 * Hash algorithms supported for TDX quotes.
 */
export type TdxQuoteHashAlgorithm = "sha256" | "sha384" | "sha512" | "raw";

/**
 * Validate TEE mode string.
 */
export function parseTeeMode(mode: string): TeeMode {
  switch (mode.toUpperCase()) {
    case "LOCAL":
      return TeeMode.LOCAL;
    case "DOCKER":
      return TeeMode.DOCKER;
    case "PRODUCTION":
      return TeeMode.PRODUCTION;
    default:
      throw new Error(
        `Invalid TEE_MODE: ${mode}. Must be one of: LOCAL, DOCKER, PRODUCTION`
      );
  }
}

/**
 * Validate TEE vendor string.
 */
export function parseTeeVendor(vendor: string): TeeVendor {
  switch (vendor.toLowerCase()) {
    case "phala":
      return TeeVendor.PHALA;
    default:
      throw new Error(`Invalid TEE_VENDOR: ${vendor}. Must be one of: phala`);
  }
}


