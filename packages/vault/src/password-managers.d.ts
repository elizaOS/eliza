import type { PasswordManagerReference } from "./types.js";
/**
 * Resolve a password-manager reference at use time.
 *
 * 1Password: shells out to `op read op://<vault>/<item>/<field>`.
 * Proton Pass: scaffolded; the vendor's CLI/SDK isn't stable enough
 * to wire in v1.
 *
 * The reference contents are never copied to disk by the vault; only
 * the reference itself (`{ source, path }`) is stored.
 */
export declare class PasswordManagerError extends Error {
    readonly source: PasswordManagerReference["source"];
    constructor(source: PasswordManagerReference["source"], message: string);
}
export declare function resolveReference(ref: PasswordManagerReference): Promise<string>;
//# sourceMappingURL=password-managers.d.ts.map