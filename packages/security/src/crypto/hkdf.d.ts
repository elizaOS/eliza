/**
 * HKDF-SHA256. Returns `length` bytes derived from `ikm` with optional salt and info.
 * Used by adapters to derive sub-keys (e.g. per-version DEKs from a single Steward-held root).
 */
export declare function hkdfSha256(ikm: Uint8Array, length: number, info?: Uint8Array, salt?: Uint8Array): Uint8Array;
//# sourceMappingURL=hkdf.d.ts.map