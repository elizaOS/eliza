/**
 * Abstract base classes every TEE vendor implements: `DeriveKeyProvider` for
 * deterministic key derivation, `RemoteAttestationProvider` for TDX quote
 * generation. Vendor-specific implementations live under `../vendors`.
 */
import type {
  DeriveKeyResult,
  RemoteAttestationQuote,
  TdxQuoteHashAlgorithm,
} from "../types";

export abstract class DeriveKeyProvider {
  abstract rawDeriveKey(
    path: string,
    subject: string,
  ): Promise<DeriveKeyResult>;
}

export abstract class RemoteAttestationProvider {
  abstract generateAttestation(
    reportData: string,
    hashAlgorithm?: TdxQuoteHashAlgorithm,
  ): Promise<RemoteAttestationQuote>;
}
