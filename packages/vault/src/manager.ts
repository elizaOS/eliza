import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createVault, type Vault } from "./vault.js";
import type { PasswordManagerReference } from "./types.js";

const exec = promisify(execFile);

/**
 * SecretsManager — the high-level routing layer over Vault.
 *
 * Lets a user pick which backends to enable for sensitive secrets:
 *
 *   - "in-house"   → Milady's local store (OS keychain master + AES-GCM file)
 *   - "1password"  → 1Password CLI (`op`); references stored locally
 *   - "protonpass" → Proton Pass (scaffolded; vendor CLI not stable yet)
 *   - "bitwarden"  → Bitwarden CLI (`bw`); references stored locally
 *
 * Three modes the user can run in:
 *
 *   - **None enabled** → only "in-house" is used. Default.
 *   - **One enabled**  → user picked (e.g.) "1password"; sensitive values
 *     route there, falling back to in-house if it's unavailable.
 *   - **All enabled**  → user can pick per-key in Settings; falls back
 *     down the priority list to in-house.
 *
 * The Vault stays the canonical store for non-sensitive config and
 * for the references that point at external password managers.
 */

export type BackendId =
  | "in-house"
  | "1password"
  | "protonpass"
  | "bitwarden";

export interface BackendStatus {
  readonly id: BackendId;
  readonly label: string;
  /** True if the backend is available on this machine. */
  readonly available: boolean;
  /**
   * True if the user is currently authenticated to this backend.
   * Undefined when not applicable (e.g., in-house) or detection
   * isn't supported yet.
   */
  readonly signedIn?: boolean;
  /** Human-readable detail for display when not fully ready. */
  readonly detail?: string;
}

export interface ManagerPreferences {
  /**
   * Backends the user has enabled, ordered by priority.
   * "in-house" is always implicitly available as a fallback even if
   * not listed here.
   */
  readonly enabled: readonly BackendId[];
  /**
   * Per-key routing overrides. Useful when a user wants e.g. work
   * keys in 1Password and personal keys in Bitwarden.
   */
  readonly routing?: Readonly<Record<string, BackendId>>;
}

export const DEFAULT_PREFERENCES: ManagerPreferences = {
  enabled: ["in-house"],
};

export interface ManagerSetOptions {
  readonly sensitive?: boolean;
  /** Force routing to a specific backend, overriding preferences. */
  readonly store?: BackendId;
  /**
   * When using an external password manager, the path to the existing
   * item there (e.g., "Personal/OpenRouter/api-key" for 1Password).
   * The value must already exist in the password manager — Milady
   * doesn't auto-create items in v1.
   */
  readonly externalPath?: string;
  readonly caller?: string;
}

export interface SecretsManager {
  /** The underlying vault. Use directly for advanced cases. */
  readonly vault: Vault;
  /** Set a value, routing per the user's preferences. */
  set(key: string, value: string, opts?: ManagerSetOptions): Promise<void>;
  /** Get a value, resolving through whatever backend it's stored in. */
  get(key: string): Promise<string>;
  /** Existence check. */
  has(key: string): Promise<boolean>;
  /** Remove (clears the local entry; doesn't delete from external password manager). */
  remove(key: string): Promise<void>;
  /** List keys. */
  list(prefix?: string): Promise<readonly string[]>;
  /** Probe each known backend; returns availability + sign-in status. */
  detectBackends(): Promise<readonly BackendStatus[]>;
  /** Read the user's saved preferences. */
  getPreferences(): Promise<ManagerPreferences>;
  /** Save the user's preferences. Persisted to the vault. */
  setPreferences(prefs: ManagerPreferences): Promise<void>;
}

export interface CreateManagerOptions {
  /** Provide your own Vault. Default: `createVault()`. */
  readonly vault?: Vault;
}

export function createManager(opts: CreateManagerOptions = {}): SecretsManager {
  const vault = opts.vault ?? createVault();
  return new ManagerImpl(vault);
}

const PREFERENCES_KEY = "_manager.preferences";

class ManagerImpl implements SecretsManager {
  constructor(readonly vault: Vault) {}

  async getPreferences(): Promise<ManagerPreferences> {
    try {
      const raw = await this.vault.get(PREFERENCES_KEY);
      const parsed = JSON.parse(raw) as ManagerPreferences;
      return normalizePreferences(parsed);
    } catch {
      return DEFAULT_PREFERENCES;
    }
  }

  async setPreferences(prefs: ManagerPreferences): Promise<void> {
    const normalized = normalizePreferences(prefs);
    await this.vault.set(PREFERENCES_KEY, JSON.stringify(normalized));
  }

  async set(
    key: string,
    value: string,
    opts: ManagerSetOptions = {},
  ): Promise<void> {
    const target = await this.resolveTargetBackend(key, opts);
    if (target === "in-house") {
      await this.vault.set(key, value, {
        ...(opts.sensitive ? { sensitive: true } : {}),
        ...(opts.caller ? { caller: opts.caller } : {}),
      });
      return;
    }
    if (!opts.externalPath) {
      throw new TypeError(
        `manager.set: routing to "${target}" requires an externalPath. Create the item in your password manager first, then call setReference, or pass externalPath here.`,
      );
    }
    if (target === "protonpass" || target === "1password") {
      const ref: PasswordManagerReference = {
        source: target,
        path: opts.externalPath,
      };
      await this.vault.setReference(key, ref);
      return;
    }
    // Bitwarden references aren't yet first-class in the vault types.
    // Document the limitation rather than silently doing nothing.
    throw new Error(
      `manager.set: backend "${target}" is detected but reference storage isn't implemented in v1. Use "in-house" or "1password" for now.`,
    );
  }

  async get(key: string): Promise<string> {
    return this.vault.get(key);
  }

  async has(key: string): Promise<boolean> {
    return this.vault.has(key);
  }

  async remove(key: string): Promise<void> {
    return this.vault.remove(key);
  }

  async list(prefix?: string): Promise<readonly string[]> {
    const all = await this.vault.list(prefix);
    // Filter out manager-internal keys.
    return all.filter((k) => !k.startsWith("_manager."));
  }

  async detectBackends(): Promise<readonly BackendStatus[]> {
    return Promise.all([
      Promise.resolve(detectInHouse()),
      detectOnePassword(),
      detectProtonPass(),
      detectBitwarden(),
    ]);
  }

  private async resolveTargetBackend(
    key: string,
    opts: ManagerSetOptions,
  ): Promise<BackendId> {
    if (opts.store) return opts.store;
    const prefs = await this.getPreferences();
    if (prefs.routing?.[key]) {
      const routed = prefs.routing[key];
      if (routed) return routed;
    }
    // Non-sensitive values always go in-house — no point routing config
    // values like UI theme through a password manager.
    if (!opts.sensitive) return "in-house";
    // For sensitive: first enabled backend, or in-house as the
    // fallback when nothing is enabled.
    return prefs.enabled[0] ?? "in-house";
  }
}

function normalizePreferences(prefs: ManagerPreferences): ManagerPreferences {
  const validIds = new Set<BackendId>([
    "in-house",
    "1password",
    "protonpass",
    "bitwarden",
  ]);
  const enabled = (Array.isArray(prefs.enabled) ? prefs.enabled : []).filter(
    (id): id is BackendId => validIds.has(id as BackendId),
  );
  if (enabled.length === 0) enabled.push("in-house");
  const routing: Record<string, BackendId> = {};
  if (prefs.routing && typeof prefs.routing === "object") {
    for (const [k, v] of Object.entries(prefs.routing)) {
      if (typeof k === "string" && validIds.has(v)) {
        routing[k] = v;
      }
    }
  }
  return { enabled, ...(Object.keys(routing).length > 0 ? { routing } : {}) };
}

// ── Detection helpers ──────────────────────────────────────────────

function detectInHouse(): BackendStatus {
  return {
    id: "in-house",
    label: "Milady (local, encrypted)",
    available: true,
    signedIn: true,
  };
}

async function detectOnePassword(): Promise<BackendStatus> {
  const present = await isCommandAvailable("op");
  if (!present) {
    return {
      id: "1password",
      label: "1Password",
      available: false,
      detail:
        "`op` CLI not installed. Get it at https://developer.1password.com/docs/cli",
    };
  }
  try {
    await exec("op", ["whoami"], { timeout: 3000 });
    return {
      id: "1password",
      label: "1Password",
      available: true,
      signedIn: true,
    };
  } catch {
    return {
      id: "1password",
      label: "1Password",
      available: true,
      signedIn: false,
      detail: "`op` is installed but not signed in. Run `eval $(op signin)`.",
    };
  }
}

async function detectProtonPass(): Promise<BackendStatus> {
  const present = await isCommandAvailable("protonpass-cli");
  return {
    id: "protonpass",
    label: "Proton Pass",
    available: present,
    detail: present
      ? "Detected; reference storage will be wired when the vendor CLI stabilizes."
      : "`protonpass-cli` not installed (vendor CLI is in beta).",
  };
}

async function detectBitwarden(): Promise<BackendStatus> {
  const present = await isCommandAvailable("bw");
  if (!present) {
    return {
      id: "bitwarden",
      label: "Bitwarden",
      available: false,
      detail: "`bw` CLI not installed. https://bitwarden.com/help/cli/",
    };
  }
  try {
    const { stdout } = await exec("bw", ["status"], {
      timeout: 3000,
      encoding: "utf8",
    });
    const status = JSON.parse(stdout.trim()) as { status?: string };
    if (status.status === "unlocked") {
      return {
        id: "bitwarden",
        label: "Bitwarden",
        available: true,
        signedIn: true,
      };
    }
    return {
      id: "bitwarden",
      label: "Bitwarden",
      available: true,
      signedIn: false,
      detail:
        status.status === "locked"
          ? "`bw` is signed in but locked. Run `bw unlock`."
          : "`bw` is installed but not signed in. Run `bw login`.",
    };
  } catch {
    return {
      id: "bitwarden",
      label: "Bitwarden",
      available: true,
      signedIn: false,
      detail: "`bw status` failed; CLI may need an update.",
    };
  }
}

async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await exec("where.exe", [cmd], { timeout: 3000 });
    } else {
      // Use `which` directly — argv array, no shell interpolation.
      await exec("which", [cmd], { timeout: 3000 });
    }
    return true;
  } catch {
    return false;
  }
}
