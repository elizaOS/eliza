/**
 * Where the encryption master key lives.
 *
 * Resolvers, ordered by preference for `defaultMasterKey()`:
 *
 *   1. **OS keychain** — cross-platform via @napi-rs/keyring (macOS
 *      Keychain, Windows Credential Manager, Linux Secret Service /
 *      libsecret). The default on machines with a desktop session.
 *   2. **Passphrase** — scrypt-derived 32-byte key from `ELIZA_VAULT_PASSPHRASE`
 *      with a per-service salt. Use this on headless Linux servers, in
 *      Docker containers, or in CI where the OS keychain isn't reachable.
 *      Operator opts in by setting the env var; we never derive from a
 *      hard-coded fallback.
 *   3. **In-memory** — `inMemoryMasterKey(buffer)`. Tests only.
 *
 * `defaultMasterKey()` walks 1 → 2 and throws a single
 * `MasterKeyUnavailableError` with both paths' diagnostic messages when
 * neither is available. Operators see a single line that names every
 * remediation option.
 */
export interface MasterKeyResolver {
    load(): Promise<Buffer>;
    describe(): string;
}
export declare class MasterKeyUnavailableError extends Error {
    constructor(message: string);
}
export declare function inMemoryMasterKey(key: Buffer): MasterKeyResolver;
export interface OsKeychainOptions {
    /** Service name shown in the OS keychain UI. Default: "eliza". */
    readonly service?: string;
    /** Account/account name within the service. Default: "vault.masterKey". */
    readonly account?: string;
}
export interface PassphraseOptions {
    /**
     * Passphrase string. Typically read from `process.env.ELIZA_VAULT_PASSPHRASE`.
     * Must be at least 12 characters; shorter passphrases are rejected to
     * push operators away from trivially-brute-forceable keys.
     */
    readonly passphrase: string;
    /**
     * Salt for the scrypt KDF. Default: derived from the service identifier
     * so two distinct services on the same host with the same passphrase
     * still produce different keys. Override only if you know what you're
     * doing — changing the salt invalidates every value already in the
     * vault.
     */
    readonly salt?: string;
    /**
     * scrypt cost. Default 2^15 = 32_768 — same order of magnitude as 1Password's
     * recommendation for a master password derivation, comfortably below the
     * default 64MB memory cap on Node's scrypt. Override for tests if needed.
     */
    readonly cost?: number;
    /** Service identifier used as the default salt prefix. Default `"eliza"`. */
    readonly service?: string;
}
/**
 * Master key derived from a passphrase via scrypt. Use this when no OS
 * keychain is available — typically headless Linux servers or containers.
 *
 * The same passphrase + salt + cost always produces the same key, so
 * operators MUST keep their passphrase stable across restarts (otherwise
 * existing ciphertext can no longer be decrypted).
 */
export declare function passphraseMasterKey(opts: PassphraseOptions): MasterKeyResolver;
/**
 * Construct a passphrase resolver from `ELIZA_VAULT_PASSPHRASE` env. Returns
 * `null` when the env var is absent or empty so callers can fall through
 * to the next strategy without a try/catch dance.
 */
export declare function passphraseMasterKeyFromEnv(service?: string): MasterKeyResolver | null;
/**
 * Default resolver: try the OS keychain first, then a passphrase-derived
 * key from `ELIZA_VAULT_PASSPHRASE`. If both fail, throws a single
 * `MasterKeyUnavailableError` whose message lists every remediation
 * option so operators on a fresh headless box see one actionable line.
 *
 * Tests should NOT use this — pass `inMemoryMasterKey(...)` to
 * `createVault()` directly. Production paths that already inject a
 * resolver are unaffected.
 */
export declare function defaultMasterKey(opts?: OsKeychainOptions): MasterKeyResolver;
export declare function osKeychainMasterKey(opts?: OsKeychainOptions): MasterKeyResolver;
//# sourceMappingURL=master-key.d.ts.map