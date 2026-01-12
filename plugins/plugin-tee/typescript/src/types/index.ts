export enum TeeMode {
  LOCAL = "LOCAL",
  DOCKER = "DOCKER",
  PRODUCTION = "PRODUCTION",
}

export enum TeeVendor {
  PHALA = "phala",
}

export enum TeeType {
  SGX_GRAMINE = "sgx_gramine",
  TDX_DSTACK = "tdx_dstack",
}

export interface RemoteAttestationQuote {
  readonly quote: string;
  readonly timestamp: number;
}

export interface DeriveKeyAttestationData {
  readonly agentId: string;
  readonly publicKey: string;
  readonly subject?: string;
}

export interface RemoteAttestationMessage {
  readonly agentId: string;
  readonly timestamp: number;
  readonly message: {
    readonly entityId: string;
    readonly roomId: string;
    readonly content: string;
  };
}

export interface DeriveKeyResult {
  readonly key: Uint8Array;
  readonly certificateChain: string[];
}

export interface Ed25519KeypairResult {
  readonly publicKey: string;
  readonly secretKey: Uint8Array;
  readonly attestation: RemoteAttestationQuote;
}

export interface EcdsaKeypairResult {
  readonly address: string;
  readonly privateKey: Uint8Array;
  readonly attestation: RemoteAttestationQuote;
}

export interface TeeServiceConfig {
  readonly mode: TeeMode;
  readonly vendor: TeeVendor;
  readonly secretSalt?: string;
}

export interface TeeProviderResult {
  readonly data: Record<string, string> | null;
  readonly values: Record<string, string>;
  readonly text: string;
}

export type TdxQuoteHashAlgorithm = "sha256" | "sha384" | "sha512" | "raw";

export function parseTeeMode(mode: string): TeeMode {
  switch (mode.toUpperCase()) {
    case "LOCAL":
      return TeeMode.LOCAL;
    case "DOCKER":
      return TeeMode.DOCKER;
    case "PRODUCTION":
      return TeeMode.PRODUCTION;
    default:
      throw new Error(`Invalid TEE_MODE: ${mode}. Must be one of: LOCAL, DOCKER, PRODUCTION`);
  }
}

export function parseTeeVendor(vendor: string): TeeVendor {
  switch (vendor.toLowerCase()) {
    case "phala":
      return TeeVendor.PHALA;
    default:
      throw new Error(`Invalid TEE_VENDOR: ${vendor}. Must be one of: phala`);
  }
}
