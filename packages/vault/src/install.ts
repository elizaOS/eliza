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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BackendId } from "./manager.js";

const exec = promisify(execFile);

/** A concrete way to install one CLI on one OS. */
export type InstallMethod =
  | {
      readonly kind: "brew";
      /** brew formula or cask name. */
      readonly package: string;
      /** True for `brew install --cask <package>`. */
      readonly cask: boolean;
    }
  | {
      readonly kind: "npm";
      /** npm package name to install with `-g`. */
      readonly package: string;
    }
  | {
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
  readonly methods: Readonly<
    Partial<Record<SupportedPlatform, readonly InstallMethod[]>>
  >;
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
export const BACKEND_INSTALL_SPECS: Readonly<
  Record<Exclude<BackendId, "in-house">, BackendInstallSpec>
> = {
  "1password": {
    id: "1password",
    methods: {
      darwin: [
        { kind: "brew", package: "1password-cli", cask: true },
        {
          kind: "manual",
          instructions:
            "Download the 1Password CLI installer for macOS from the official page.",
          url: "https://developer.1password.com/docs/cli/get-started",
        },
      ],
      linux: [
        {
          kind: "manual",
          instructions:
            "Follow the official Linux install instructions (apt/dnf/zypper repo with signed packages).",
          url: "https://developer.1password.com/docs/cli/get-started/#linux",
        },
      ],
      win32: [
        {
          kind: "manual",
          instructions:
            "Install via winget or the MSI from the official 1Password CLI page.",
          url: "https://developer.1password.com/docs/cli/get-started/#windows",
        },
      ],
    },
  },
  bitwarden: {
    id: "bitwarden",
    methods: {
      darwin: [
        { kind: "brew", package: "bitwarden-cli", cask: false },
        { kind: "npm", package: "@bitwarden/cli" },
      ],
      linux: [{ kind: "npm", package: "@bitwarden/cli" }],
      win32: [{ kind: "npm", package: "@bitwarden/cli" }],
    },
  },
  protonpass: {
    id: "protonpass",
    methods: {
      darwin: [
        {
          kind: "manual",
          instructions:
            "Proton Pass CLI is in closed beta. Track Proton's roadmap or use the desktop app.",
          url: "https://proton.me/pass",
        },
      ],
      linux: [
        {
          kind: "manual",
          instructions:
            "Proton Pass CLI is in closed beta. Track Proton's roadmap or use the desktop app.",
          url: "https://proton.me/pass",
        },
      ],
      win32: [
        {
          kind: "manual",
          instructions:
            "Proton Pass CLI is in closed beta. Track Proton's roadmap or use the desktop app.",
          url: "https://proton.me/pass",
        },
      ],
    },
  },
};

/**
 * Per-OS package-manager availability (brew/npm). Cached for the process
 * lifetime — the result doesn't change without a host-level install/remove,
 * and the caller can force a re-detect by importing `resetInstallerCache`.
 */
let _packageManagerCache: PackageManagerAvailability | null = null;

export interface PackageManagerAvailability {
  readonly brew: boolean;
  readonly npm: boolean;
}

export async function detectPackageManagers(): Promise<PackageManagerAvailability> {
  if (_packageManagerCache) return _packageManagerCache;
  const [brew, npm] = await Promise.all([
    isCommandRunnable("brew"),
    isCommandRunnable("npm"),
  ]);
  _packageManagerCache = { brew, npm };
  return _packageManagerCache;
}

export function resetInstallerCache(): void {
  _packageManagerCache = null;
}

async function isCommandRunnable(cmd: string): Promise<boolean> {
  try {
    await exec(cmd, ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the install methods that are *runnable on this host* for a given
 * backend. Manual methods are always returned (so the UI can show the doc
 * link); brew/npm methods are filtered to those whose tool is present.
 */
export async function resolveRunnableMethods(
  id: Exclude<BackendId, "in-house">,
  platform: SupportedPlatform = currentPlatform(),
): Promise<readonly InstallMethod[]> {
  const spec = BACKEND_INSTALL_SPECS[id];
  const candidates = spec.methods[platform] ?? [];
  if (candidates.length === 0) return [];
  const tools = await detectPackageManagers();
  return candidates.filter((m) => {
    if (m.kind === "brew") return tools.brew;
    if (m.kind === "npm") return tools.npm;
    return true;
  });
}

export function currentPlatform(): SupportedPlatform {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  // Treat anything else as linux for dispatch purposes; specs only ship the
  // three primary platforms today.
  return "linux";
}

/**
 * Build the argv for a given install method. Caller spawns directly with
 * argv (no shell interpolation). Returns null for `manual` — those have no
 * automated execution path.
 */
export function buildInstallCommand(
  method: InstallMethod,
): { command: string; args: readonly string[] } | null {
  if (method.kind === "brew") {
    const args = method.cask
      ? ["install", "--cask", method.package]
      : ["install", method.package];
    return { command: "brew", args };
  }
  if (method.kind === "npm") {
    return { command: "npm", args: ["install", "-g", method.package] };
  }
  return null;
}
