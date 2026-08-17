/**
 * Bounds Circle IRIS attestation HTTP requests shared by EVM and Solana bridge flows.
 */

export const CIRCLE_ATTESTATION_FETCH_TIMEOUT_MS = 10_000;

export function fetchCircleAttestation(url: string): Promise<Response> {
  // @duplicate-component-audit-allow Circle attestation polling is not an LLM generation call.
  return fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(CIRCLE_ATTESTATION_FETCH_TIMEOUT_MS),
  });
}
