/**
 * External credential adapters for password-manager backends.
 *
 * Reads Login items out of `op` (1Password) and `bw` (Bitwarden) using the
 * session token persisted by the secrets-manager installer at
 * `pm.<backend>.session`. Returns a uniform shape so the manager layer can
 * merge them with the in-house saved-logins list.
 *
 *   list*  → metadata only, never returns passwords
 *   reveal* → explicit second step, returns username + password (+ totp)
 *
 * The CLI is shelled out via an injected `ExecFn` so tests can stub the
 * subprocess without spawning real processes.
 */
import type { Vault } from "./vault.js";
export type ExternalLoginSource = "1password" | "bitwarden";
export interface ExternalLoginListEntry {
    readonly source: ExternalLoginSource;
    /** op item id / bw item id — opaque to callers. */
    readonly externalId: string;
    readonly title: string;
    readonly username: string;
    /** Best-effort registrable hostname extracted from urls[0]; null when none. */
    readonly domain: string | null;
    readonly url: string | null;
    /** Epoch ms; 0 when the backend didn't supply a timestamp. */
    readonly updatedAt: number;
}
export interface ExternalLoginReveal extends ExternalLoginListEntry {
    readonly password: string;
    readonly totp?: string;
}
export declare class BackendNotSignedInError extends Error {
    readonly source: ExternalLoginSource;
    constructor(source: ExternalLoginSource);
}
/**
 * Subprocess executor injected by the manager (tests pass a stub).
 *
 * Mirrors `node:child_process.execFile` with promises: returns combined
 * stdout/stderr, throws on non-zero exit. The `env` option matters for
 * Bitwarden (BW_SESSION) — 1Password uses an explicit `--session` flag.
 */
export type ExecFn = (cmd: string, args: readonly string[], opts: {
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly stdin?: string;
}) => Promise<{
    readonly stdout: string;
    readonly stderr: string;
}>;
export declare function listOnePasswordLogins(vault: Vault, exec: ExecFn): Promise<readonly ExternalLoginListEntry[]>;
export declare function revealOnePasswordLogin(vault: Vault, exec: ExecFn, externalId: string): Promise<ExternalLoginReveal>;
export declare function listBitwardenLogins(vault: Vault, exec: ExecFn): Promise<readonly ExternalLoginListEntry[]>;
export declare function revealBitwardenLogin(vault: Vault, exec: ExecFn, externalId: string): Promise<ExternalLoginReveal>;
/**
 * Production `ExecFn` wrapping `node:child_process.execFile`. Tests inject
 * stubs instead of using this. Lives here so callers can `import` a single
 * default rather than wiring `child_process` themselves.
 */
export declare function defaultExecFn(): ExecFn;
//# sourceMappingURL=external-credentials.d.ts.map