import type { RemoteAttestationQuote } from '@elizaos/core';
import type { TdxQuoteHashAlgorithms } from '@phala/dstack-sdk';

/**
 * Abstract class for deriving keys from the TEE.
 * You can implement your own logic for deriving keys from the TEE.
 * @example
 * ```ts
 * class MyDeriveKeyProvider extends DeriveKeyProvider {
 *   private client: TappdClient;
 *
 *   constructor(endpoint: string) {
 *     super();
 *     this.client = new TappdClient();
 *   }
 *
 *   async rawDeriveKey(path: string, subject: string): Promise<any> {
 *     return this.client.deriveKey(path, subject);
 *   }
 * }
 * ```
 */
/**
 * Abstract class representing a key provider for deriving keys.
 */
export abstract class DeriveKeyProvider {}

/**
 * Abstract class for remote attestation provider.
 */
export abstract class RemoteAttestationProvider {
  abstract generateAttestation(
    reportData: string,
    hashAlgorithm?: TdxQuoteHashAlgorithms
  ): Promise<RemoteAttestationQuote>;
}
