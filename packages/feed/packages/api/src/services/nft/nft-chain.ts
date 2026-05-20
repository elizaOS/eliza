import { CHAIN_ID, ValidationError } from '@babylon/shared';

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Babylon runs the NFT flow on a single chain per environment.
 *
 * Source of truth: `NEXT_PUBLIC_CHAIN_ID` (or `CHAIN_ID` on the server).
 *
 * `NFT_CHAIN_ID` is treated as a legacy env var:
 * - if set, it must parse as a positive integer
 * - and it must match `CHAIN_ID` to prevent hard-to-debug chain drift
 */
export function getNftChainId(): number {
  const legacyRaw = process.env.NFT_CHAIN_ID?.trim();
  if (!legacyRaw) return CHAIN_ID;

  const legacyParsed = parsePositiveInt(legacyRaw);
  if (!legacyParsed) {
    throw new ValidationError(
      'NFT_CHAIN_ID is invalid',
      ['NFT_CHAIN_ID'],
      [{ field: 'NFT_CHAIN_ID', message: 'Must be a positive integer' }]
    );
  }

  if (legacyParsed !== CHAIN_ID) {
    throw new ValidationError(
      'NFT_CHAIN_ID must match NEXT_PUBLIC_CHAIN_ID/CHAIN_ID',
      ['NFT_CHAIN_ID', 'NEXT_PUBLIC_CHAIN_ID', 'CHAIN_ID'],
      [
        {
          field: 'NFT_CHAIN_ID',
          message: `Expected ${CHAIN_ID} but got ${legacyParsed}`,
        },
      ]
    );
  }

  return CHAIN_ID;
}
