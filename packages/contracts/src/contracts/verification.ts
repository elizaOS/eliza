/**
 * Shared verification API contracts.
 */

export interface VerificationResult {
  verified: boolean;
  error: string | null;
  handle: string | null;
}
