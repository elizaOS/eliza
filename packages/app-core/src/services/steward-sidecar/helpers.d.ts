/**
 * Steward Sidecar - utility helpers.
 */
/**
 * Fingerprint a high-entropy (>= 256-bit) random token using SHA-256.
 *
 * This is NOT a password hash - the steward-fi sidecar protocol stores
 * `sha256(token)` as a wire-format identifier for a randomly generated
 * token, and the comparison is timing-safe on the server. Slow KDFs are
 * unnecessary for high-entropy random tokens.
 */
export declare function fingerprintRandomToken(token: string): string;
export declare function resolveDataDir(dataDir: string): string;
export declare function generateApiKey(): string;
export declare function generateMasterPassword(): string;
export declare function sleep(ms: number): Promise<void>;
export declare function allocateFirstFreeLoopbackPort(
  preferred: number,
  options?: {
    host?: string;
    maxHops?: number;
  },
): Promise<number>;
//# sourceMappingURL=helpers.d.ts.map
