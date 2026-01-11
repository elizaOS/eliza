/**
 * Abstract base classes for TEE providers.
 */

import type { RemoteAttestationQuote, TdxQuoteHashAlgorithm, DeriveKeyResult } from "../types";

/**
 * Abstract class for deriving keys from the TEE.
 *
 * Implement this class to support different TEE vendors.
 *
 * @example
 * ```ts
 * class MyDeriveKeyProvider extends DeriveKeyProvider {
 *   async rawDeriveKey(path: string, subject: string): Promise<DeriveKeyResult> {
 *     return this.client.deriveKey(path, subject);
 *   }
 * }
 * ```
 */
export abstract class DeriveKeyProvider {
  /**
   * Derive a raw key from the TEE.
   *
   * @param path - The derivation path.
   * @param subject - The subject for the certificate chain.
   * @returns The derived key result.
   */
  abstract rawDeriveKey(path: string, subject: string): Promise<DeriveKeyResult>;
}

/**
 * Abstract class for remote attestation provider.
 *
 * Implement this class to support different TEE vendors.
 */
export abstract class RemoteAttestationProvider {
  /**
   * Generate a remote attestation quote.
   *
   * @param reportData - The data to include in the attestation report.
   * @param hashAlgorithm - Optional hash algorithm for the quote.
   * @returns The remote attestation quote.
   */
  abstract generateAttestation(
    reportData: string,
    hashAlgorithm?: TdxQuoteHashAlgorithm
  ): Promise<RemoteAttestationQuote>;
}


