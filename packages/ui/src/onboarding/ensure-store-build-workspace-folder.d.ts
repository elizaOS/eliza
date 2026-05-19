/**
 * Store-build workspace folder helper.
 *
 * Use under MAS / Flathub / MSIX AppContainer store builds where the OS
 * sandbox scopes filesystem reach to the app container plus user-granted
 * folders. Idempotent: only prompts when no stored folder exists; re-
 * resolves the macOS security-scoped bookmark on subsequent launches.
 *
 * Wire-in points:
 *   1. StartupShell mount-time effect — re-resolves the stored bookmark
 *      every launch so the host process holds an active access grant.
 *   2. Onboarding deployment-step exit — the natural prompt moment for
 *      first-run users on store builds.
 *
 * On non-store builds this is a no-op — direct downloads have full host
 * access and don't need a workspace folder grant.
 */
import { type StoredWorkspaceFolder } from "../storage/workspace-folder";
export type EnsureWorkspaceFolderResult = {
    kind: "skipped";
    reason: "non-store-build" | "not-electrobun";
} | {
    kind: "stored";
    folder: StoredWorkspaceFolder;
    freshlyPicked: boolean;
} | {
    kind: "canceled";
} | {
    kind: "stale-bookmark";
    oldPath: string;
};
interface EnsureOptions {
    defaultPath?: string;
    promptTitle?: string;
    forcePicker?: boolean;
}
export declare function ensureStoreBuildWorkspaceFolder(options?: EnsureOptions): Promise<EnsureWorkspaceFolderResult>;
export {};
//# sourceMappingURL=ensure-store-build-workspace-folder.d.ts.map