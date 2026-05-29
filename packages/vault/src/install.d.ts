/**
 * Install spec — what install methods exist for each external secrets-manager
 * backend on which OS, and how to detect whether a given package manager is
 * present on the host.
 *
 * Detection-only. The actual `child_process` execution and streaming live in
 * the consumer (app-core's `secrets-manager-installer`); this module is pure
 * data + small async checks so it stays usable from the vault package
 * without pulling in spawn/PTY machinery.
 */
import type { BackendId } from "./manager.js";
/** A concrete way to install one CLI on one OS. */
export type InstallMethod = {
    readonly kind: "brew";
    /** brew formula or cask name. */
    readonly package: string;
    /** True for `brew install --cask <package>`. */
    readonly cask: boolean;
} | {
    readonly kind: "npm";
    /** npm package name to install with `-g`. */
    readonly package: string;
} | {
    readonly kind: "manual";
    readonly instructions: string;
    readonly url: string;
};
export type InstallMethodKind = InstallMethod["kind"];
export type SupportedPlatform = "darwin" | "linux" | "win32";
/** Per-OS install methods for one backend. */
export interface BackendInstallSpec {
    readonly id: BackendId;
    /** First entry in each platform list is the preferred default. */
    readonly methods: Readonly<Partial<Record<SupportedPlatform, readonly InstallMethod[]>>>;
}
/**
 * Install specs for each external backend.
 *
 * Sources:
 *   - 1Password CLI: `brew install --cask 1password-cli`
 *     (https://developer.1password.com/docs/cli/get-started)
 *   - Bitwarden CLI: `brew install bitwarden-cli` (formula, not cask) or
 *     `npm install -g @bitwarden/cli`
 *     (https://bitwarden.com/help/cli/)
 *   - Proton Pass CLI: vendor CLI is in beta, no automated install path yet.
 */
export declare const BACKEND_INSTALL_SPECS: Readonly<Record<Exclude<BackendId, "in-house">, BackendInstallSpec>>;
export interface PackageManagerAvailability {
    readonly brew: boolean;
    readonly npm: boolean;
}
export declare function detectPackageManagers(): Promise<PackageManagerAvailability>;
export declare function resetInstallerCache(): void;
/**
 * Resolve the install methods that are *runnable on this host* for a given
 * backend. Manual methods are always returned (so the UI can show the doc
 * link); brew/npm methods are filtered to those whose tool is present.
 */
export declare function resolveRunnableMethods(id: Exclude<BackendId, "in-house">, platform?: SupportedPlatform): Promise<readonly InstallMethod[]>;
export declare function currentPlatform(): SupportedPlatform;
/**
 * Build the argv for a given install method. Caller spawns directly with
 * argv (no shell interpolation). Returns null for `manual` — those have no
 * automated execution path.
 */
export declare function buildInstallCommand(method: InstallMethod): {
    command: string;
    args: readonly string[];
} | null;
//# sourceMappingURL=install.d.ts.map