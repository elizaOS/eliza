/**
 * Secrets-manager installer + signin orchestration.
 *
 * Drives the lifecycle the UI cares about for the three external secrets-manager
 * backends (1Password, Bitwarden, Proton Pass):
 *
 *   1. **Install**       — spawn the chosen package manager (brew or npm) with
 *                          a clean argv. Streams stdout/stderr lines back to
 *                          subscribers, emits a final `done` / `error` event
 *                          when the child exits.
 *   2. **Sign in**       — runs the vendor's non-interactive signin flow with
 *                          credentials supplied once via the API. Captures the
 *                          session token from stdout and persists it in the
 *                          in-house vault as `pm.<backend>.session`.
 *   3. **Sign out**      — clears the persisted session token.
 *
 * Master passwords / API secrets enter the process exactly once per request
 * via `child.stdin`; they are never written to disk. The session tokens that
 * come back are integration metadata (not user secrets), but we still mark
 * them `sensitive: true` so they're encrypted at rest under the OS keychain.
 *
 * Singleton: one installer per process, owns a Map<jobId, InstallJob>. The
 * stream of events is also persisted in-memory on the job so a UI that
 * subscribes after spawn (race) can replay history.
 */
import { type ChildProcess } from "node:child_process";
import { type BackendId, type InstallMethod, type SecretsManager } from "@elizaos/vault";
export type InstallableBackendId = Exclude<BackendId, "in-house">;
export type InstallJobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type InstallJobEvent = {
    readonly type: "log";
    readonly stream: "stdout" | "stderr";
    readonly line: string;
} | {
    readonly type: "status";
    readonly status: InstallJobStatus;
} | {
    readonly type: "done";
    readonly exitCode: number;
} | {
    readonly type: "error";
    readonly message: string;
};
export interface InstallJobSnapshot {
    readonly id: string;
    readonly backendId: InstallableBackendId;
    readonly method: InstallMethod;
    readonly status: InstallJobStatus;
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly exitCode: number | null;
    readonly errorMessage: string | null;
    readonly history: readonly InstallJobEvent[];
}
/**
 * Injectable spawn for tests. Production callers omit this and get the real
 * `node:child_process` `spawn`. Tests pass a stub that returns a synthetic
 * `ChildProcess`-like object so we don't actually fork brew/npm.
 */
export type SpawnFn = (command: string, args: readonly string[], options: {
    stdio: ["ignore" | "pipe", "pipe", "pipe"];
    shell: false;
    env?: NodeJS.ProcessEnv;
}) => ChildProcess;
export interface InstallerDependencies {
    readonly manager: SecretsManager;
    readonly spawn?: SpawnFn;
}
export interface SigninRequest {
    readonly backendId: InstallableBackendId;
    /** 1Password: required. Bitwarden: required (`bw login` email + master pwd). */
    readonly email?: string;
    /** Master password (the user's main vault password). Used only in this request. */
    readonly masterPassword: string;
    /** 1Password: required. The 34-char "Secret Key". */
    readonly secretKey?: string;
    /** 1Password: optional sign-in URL (defaults to `my.1password.com`). */
    readonly signInAddress?: string;
    /** Bitwarden: API client_id (BW_CLIENTID). Enables the non-interactive login flow. */
    readonly bitwardenClientId?: string;
    /** Bitwarden: API client_secret (BW_CLIENTSECRET). */
    readonly bitwardenClientSecret?: string;
}
export interface SigninResult {
    readonly backendId: InstallableBackendId;
    readonly sessionStored: boolean;
    /** Truncated, human-readable detail surfaced from the CLI. Never the secret itself. */
    readonly message: string;
}
export declare class SecretsManagerInstaller {
    private readonly jobs;
    private readonly manager;
    private readonly spawn;
    constructor(deps: InstallerDependencies);
    /** Snapshot of the install methods runnable on this host for a backend. */
    getInstallMethods(id: InstallableBackendId): Promise<readonly InstallMethod[]>;
    /**
     * Spawn the install command for `method` on backend `id`. Returns a job id
     * the UI can subscribe to. The caller is expected to call `subscribeJob`
     * (or read `getJob` to poll) before the child finishes; events that fire
     * before the first subscriber are kept on `job.history` so SSE clients
     * that connect after spawn still see the full log.
     */
    startInstall(id: InstallableBackendId, method: InstallMethod): InstallJobSnapshot;
    /** Subscribe to events for a running job. Returns an unsubscribe function. */
    subscribeJob(jobId: string, listener: (event: InstallJobEvent) => void): () => void;
    getJob(jobId: string): InstallJobSnapshot | null;
    /**
     * Run the vendor's non-interactive signin flow and persist the session token.
     * Throws on validation or CLI failure with a message safe to surface to UI.
     */
    signIn(request: SigninRequest): Promise<SigninResult>;
    signOut(backendId: InstallableBackendId): Promise<void>;
    /** Read the cached session token (or null if not signed in). */
    getSession(backendId: InstallableBackendId): Promise<string | null>;
    private runInstallJob;
    private emit;
    private transition;
    private terminate;
    /**
     * Adds a 1Password account (idempotent — if the account already exists `op`
     * succeeds without re-prompting), then performs `op signin --raw` piping
     * the master password on stdin. Captures the session token returned on
     * stdout and persists it under `pm.1password.session`.
     */
    private signInOnePassword;
    /**
     * Bitwarden non-interactive flow:
     *   1. `bw login --apikey` with BW_CLIENTID / BW_CLIENTSECRET in env
     *   2. `bw unlock --raw` piping the master password on stdin
     * Captures the session token from `bw unlock --raw` and persists it.
     */
    private signInBitwarden;
}
export declare function getSecretsManagerInstaller(manager?: SecretsManager): SecretsManagerInstaller;
/** Test hook. Replace the singleton entirely (e.g. with a fake spawn). */
export declare function _setSecretsManagerInstallerForTesting(next: SecretsManagerInstaller | null): void;
/** Test hook. */
export declare function _resetSecretsManagerInstallerForTesting(): void;
//# sourceMappingURL=secrets-manager-installer.d.ts.map