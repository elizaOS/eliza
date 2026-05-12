import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getSavedLogin,
  listSavedLogins,
  type SavedLoginSummary,
} from "./credentials.js";
import {
  defaultExecFn,
  type ExecFn,
  type ExternalLoginListEntry,
  type ExternalLoginReveal,
  listBitwardenLogins,
  listOnePasswordLogins,
  revealBitwardenLogin,
  revealOnePasswordLogin,
} from "./external-credentials.js";
import { type ResolutionContext, resolveActiveValue } from "./profiles.js";
import { createVault, type Vault, VaultMissError } from "./vault.js";

const exec = promisify(execFile);

/**
 * SecretsManager — the high-level routing layer over Vault.
 *
 * Lets a user pick which backends to enable for sensitive secrets:
 *
 *   - "in-house"   → Eliza's local store (OS keychain master + AES-GCM file)
 *   - "1password"  → 1Password CLI (`op`); references stored locally
 *   - "protonpass" → Proton Pass (scaffolded; vendor CLI not stable yet)
 *   - "bitwarden"  → Bitwarden CLI (`bw`); references stored locally
 *
 * Three modes the user can run in:
 *
 *   - **None enabled** → only "in-house" is used. Default.
 *   - **One enabled**  → user picked (e.g.) "1password"; sensitive values
 *     route there only when the caller stores an explicit reference.
 *   - **All enabled**  → user can pick per-key in Settings; unsupported
 *     direct external writes fail loudly instead of hiding the problem.
 *
 * The Vault stays the canonical store for non-sensitive config and
 * for the references that point at external password managers.
 */

export type BackendId = "in-house" | "1password" | "protonpass" | "bitwarden";

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
  /**
   * Authentication path the backend is using. `desktop-app` means the
   * vendor's desktop app brokers auth (e.g. 1Password 8 native app
   * integration with the `op` CLI), so no session token is required.
   * `session-token` means we authenticated via stored session token.
   * `null` when the backend is unavailable or not signed in.
   *
   * Undefined for backends that don't have multiple auth modes
   * (e.g. in-house, protonpass).
   */
  readonly authMode?: "desktop-app" | "session-token" | null;
}

export interface ManagerPreferences {
  /**
   * Backends the user has enabled, ordered by priority.
   * "in-house" is always available for non-sensitive values, but sensitive
   * values follow this order exactly and fail if the selected backend cannot
   * accept the write.
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
  readonly caller?: string;
}

export interface SecretsManager {
  /** The underlying vault. Use directly for advanced cases. */
  readonly vault: Vault;
  /** Set a value, routing per the user's preferences. */
  set(key: string, value: string, opts?: ManagerSetOptions): Promise<void>;
  /** Get a value, resolving through whatever backend it's stored in. */
  get(key: string): Promise<string>;
  /**
   * Resolve a value through the profile + per-context routing layer.
   *
   * Resolution order:
   *   1. Per-context routing rule that matches `ctx`
   *   2. The key's `_meta.<key>.activeProfile`
   *   3. The global `_routing.config.defaultProfile`
   *   4. The bare key value (legacy path)
   *
   * For keys without any meta entry, this is identical to `get()`.
   */
  getActive(key: string, ctx?: ResolutionContext): Promise<string>;
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

  /**
   * List saved logins from every available source: in-house vault always,
   * plus 1Password and Bitwarden when they're signed in.
   *
   * Per-backend errors are collected into `failures` rather than thrown —
   * a flaky external CLI must not block the in-house list.
   */
  listAllSavedLogins(
    opts?: ListAllSavedLoginsOptions,
  ): Promise<UnifiedLoginListResult>;

  /** Reveal a single login (full credentials) from the indicated source. */
  revealSavedLogin(
    source: "in-house" | "1password" | "bitwarden",
    identifier: string,
  ): Promise<UnifiedLoginReveal>;
}

export interface CreateManagerOptions {
  /** Provide your own Vault. Default: `createVault()`. */
  readonly vault?: Vault;
  /**
   * Subprocess executor for password-manager CLIs. Tests inject a stub.
   * Defaults to a real `child_process.execFile`-based runner.
   */
  readonly exec?: ExecFn;
}

/**
 * Source-tagged saved-login summary spanning every backend.
 *
 * `identifier`:
 *   - `in-house`  → `<domain>:<username>` (matches the route shape used
 *                   to delete + reveal a single in-house credential)
 *   - `1password` → the 1Password item id (op_uuid)
 *   - `bitwarden` → the Bitwarden item id (uuid)
 */
export interface UnifiedLoginListEntry {
  readonly source: "in-house" | "1password" | "bitwarden";
  readonly identifier: string;
  readonly domain: string | null;
  readonly username: string;
  /** Display name. For in-house this == username; external == op/bw title. */
  readonly title: string;
  readonly updatedAt: number;
}

export interface UnifiedLoginReveal {
  readonly source: "in-house" | "1password" | "bitwarden";
  readonly identifier: string;
  readonly username: string;
  readonly password: string;
  readonly totp?: string;
  readonly domain: string | null;
}

export interface UnifiedLoginListResult {
  readonly logins: readonly UnifiedLoginListEntry[];
  /** Per-backend errors. The list still returns whatever succeeded. */
  readonly failures: ReadonlyArray<{
    readonly source: "1password" | "bitwarden";
    readonly message: string;
  }>;
}

export interface ListAllSavedLoginsOptions {
  readonly domain?: string;
}

export function createManager(opts: CreateManagerOptions = {}): SecretsManager {
  const vault = opts.vault ?? createVault();
  const execFn = opts.exec ?? defaultExecFn();
  return new ManagerImpl(vault, execFn);
}

const PREFERENCES_KEY = "_manager.preferences";

class ManagerImpl implements SecretsManager {
  constructor(
    readonly vault: Vault,
    private readonly execFn: ExecFn,
  ) {}

  async getPreferences(): Promise<ManagerPreferences> {
    try {
      const raw = await this.vault.get(PREFERENCES_KEY);
      const parsed = JSON.parse(raw) as ManagerPreferences;
      return normalizePreferences(parsed);
    } catch (err) {
      if (err instanceof VaultMissError) {
        return DEFAULT_PREFERENCES;
      }
      throw err;
    }
  }

  async setPreferences(prefs: ManagerPreferences): Promise<void> {
    const normalized = normalizePreferences(prefs);
    // Encrypt at rest. The `routing` map can contain password-manager item
    // paths (e.g. "Personal/OpenRouter/api-key") which are internal-disclosure
    // information; storing them as a plain `kind: "value"` entry would write
    // those paths to vault.json in clear text.
    await this.vault.set(PREFERENCES_KEY, JSON.stringify(normalized), {
      sensitive: true,
    });
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
    throw new Error(
      `manager.set: backend "${target}" cannot accept direct writes yet. Store the secret in that password manager first and save a reference explicitly.`,
    );
  }

  async get(key: string): Promise<string> {
    return this.vault.get(key);
  }

  async getActive(key: string, ctx?: ResolutionContext): Promise<string> {
    return resolveActiveValue(this.vault, key, ctx);
  }

  async has(key: string): Promise<boolean> {
    return this.vault.has(key);
  }

  async remove(key: string): Promise<void> {
    return this.vault.remove(key);
  }

  async list(prefix?: string): Promise<readonly string[]> {
    const all = await this.vault.list(prefix);
    // Filter out manager-internal keys plus the inventory layer's
    // reserved prefixes — `_meta.*` (per-key metadata) and
    // `_routing.config` (global routing rules) are implementation
    // details, not user-visible keys.
    return all.filter(
      (k) =>
        !k.startsWith("_manager.") &&
        !k.startsWith("_meta.") &&
        k !== "_routing.config",
    );
  }

  async detectBackends(): Promise<readonly BackendStatus[]> {
    return Promise.all([
      Promise.resolve(detectInHouse()),
      detectOnePassword(this.vault),
      detectProtonPass(),
      detectBitwarden(this.vault),
    ]);
  }

  async listAllSavedLogins(
    opts: ListAllSavedLoginsOptions = {},
  ): Promise<UnifiedLoginListResult> {
    const requestedDomain = opts.domain
      ? opts.domain.trim().toLowerCase()
      : undefined;

    // In-house always queries successfully (or surfaces a real disk error).
    // External backends contribute only when they're signed in. Detection
    // is the gate, but we don't re-detect inline here — we pull the
    // session-token check into each adapter (it throws BackendNotSignedInError
    // when no session is stored), and skip those backends silently.
    const failures: Array<{
      source: "1password" | "bitwarden";
      message: string;
    }> = [];

    const inHouseEntries = await this.fetchInHouseEntries(requestedDomain);

    const externalEntries: ExternalLoginListEntry[] = [];
    const backends = await this.detectBackends();
    const onePasswordReady =
      backends.find((b) => b.id === "1password")?.signedIn === true;
    const bitwardenReady =
      backends.find((b) => b.id === "bitwarden")?.signedIn === true;

    if (onePasswordReady) {
      const result = await safeListExternal("1password", () =>
        listOnePasswordLogins(this.vault, this.execFn),
      );
      if (result.ok === true) externalEntries.push(...result.entries);
      else failures.push({ source: "1password", message: result.message });
    }
    if (bitwardenReady) {
      const result = await safeListExternal("bitwarden", () =>
        listBitwardenLogins(this.vault, this.execFn),
      );
      if (result.ok === true) externalEntries.push(...result.entries);
      else failures.push({ source: "bitwarden", message: result.message });
    }

    // Domain filter (case-insensitive) applies uniformly. External
    // adapters don't accept domain filters at the CLI layer — bw doesn't
    // expose one and op item list filters by tag/category only — so the
    // cost is "list everything, filter client-side". For a typical user
    // (dozens to low-hundreds of items) this stays under a second.
    const filteredExternal = requestedDomain
      ? externalEntries.filter(
          (e) =>
            e.domain !== null && e.domain.toLowerCase() === requestedDomain,
        )
      : externalEntries;

    const externalUnified: UnifiedLoginListEntry[] = filteredExternal
      .map((e) => ({
        source: e.source,
        identifier: e.externalId,
        domain: e.domain,
        username: e.username,
        title: e.title,
        updatedAt: e.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    // In-house first (sort by domain asc, username asc), then externals
    // by updatedAt desc — matches the spec.
    const sortedInHouse = [...inHouseEntries].sort((a, b) => {
      const dA = (a.domain ?? "").toLowerCase();
      const dB = (b.domain ?? "").toLowerCase();
      if (dA !== dB) return dA < dB ? -1 : 1;
      return a.username < b.username ? -1 : a.username > b.username ? 1 : 0;
    });

    return {
      logins: [...sortedInHouse, ...externalUnified],
      failures,
    };
  }

  async revealSavedLogin(
    source: "in-house" | "1password" | "bitwarden",
    identifier: string,
  ): Promise<UnifiedLoginReveal> {
    if (typeof identifier !== "string" || identifier.length === 0) {
      throw new TypeError("revealSavedLogin: identifier required");
    }
    if (source === "in-house") {
      // In-house identifier is "<domain>:<username>". The username can
      // contain `:` (rare in emails, but legitimate as a literal), so we
      // split on the FIRST colon only.
      const colon = identifier.indexOf(":");
      if (colon <= 0) {
        throw new TypeError(
          `revealSavedLogin: in-house identifier must be "<domain>:<username>", got "${identifier}"`,
        );
      }
      const domain = identifier.slice(0, colon);
      const username = identifier.slice(colon + 1);
      const login = await getSavedLogin(this.vault, domain, username);
      if (!login) {
        throw new Error(
          `revealSavedLogin: no in-house login for ${domain}:${username}`,
        );
      }
      const reveal: UnifiedLoginReveal = {
        source: "in-house",
        identifier,
        username: login.username,
        password: login.password,
        domain: login.domain,
        ...(login.otpSeed ? { totp: login.otpSeed } : {}),
      };
      return reveal;
    }
    if (source === "1password") {
      const out = await revealOnePasswordLogin(
        this.vault,
        this.execFn,
        identifier,
      );
      return mapExternalReveal(out);
    }
    // bitwarden
    const out = await revealBitwardenLogin(this.vault, this.execFn, identifier);
    return mapExternalReveal(out);
  }

  private async fetchInHouseEntries(
    requestedDomain: string | undefined,
  ): Promise<readonly UnifiedLoginListEntry[]> {
    const summaries: readonly SavedLoginSummary[] = requestedDomain
      ? await listSavedLogins(this.vault, requestedDomain)
      : await listSavedLogins(this.vault);
    return summaries.map((s) => ({
      source: "in-house" as const,
      identifier: `${s.domain}:${s.username}`,
      domain: s.domain,
      username: s.username,
      title: s.username,
      updatedAt: s.lastModified,
    }));
  }

  private async resolveTargetBackend(
    key: string,
    opts: ManagerSetOptions,
  ): Promise<BackendId> {
    // Explicit per-call override always wins.
    if (opts.store) return opts.store;
    // Non-sensitive values always go in-house — no point routing UI
    // config strings through a password manager. Checked BEFORE the
    // routing map so a stale/misconfigured `routing.ui.theme = "1password"`
    // entry can't accidentally push non-sensitive data into an
    // external store.
    if (!opts.sensitive) return "in-house";
    const prefs = await this.getPreferences();
    // Per-key routing override (sensitive case only).
    const routed = prefs.routing?.[key];
    if (routed) return routed;
    // Default for sensitive: first enabled backend; in-house if nothing is
    // enabled. External backends currently require explicit references.
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
    label: "Eliza (local, encrypted)",
    available: true,
    signedIn: true,
  };
}

async function readStoredSession(
  vault: Vault,
  backend: "1password" | "bitwarden",
): Promise<string | null> {
  try {
    const value = await vault.get(`pm.${backend}.session`);
    return value.trim() || null;
  } catch {
    return null;
  }
}

async function detectOnePassword(vault: Vault): Promise<BackendStatus> {
  const present = await isCommandAvailable("op");
  if (!present) {
    return {
      id: "1password",
      label: "1Password",
      available: false,
      detail:
        "`op` CLI not installed. Get it at https://developer.1password.com/docs/cli",
      authMode: null,
    };
  }

  // 1Password 8's CLI refuses to pick a default account when more than
  // one is registered. `op whoami` with no flags exits 1 ("account is
  // not signed in") even when desktop integration is fully active and
  // every concrete `op vault list --account=<sh>` succeeds. Probe the
  // registered accounts once and pass --account=<sh> to disambiguate.
  const account = await readDefaultOpAccount();

  // Step 1: probe `op whoami --account=<sh>` with no session token. When
  // the user has 1Password 8 desktop app installed and CLI integration
  // enabled, the CLI authenticates via the desktop app and `whoami`
  // returns 0 without any session being passed.
  if (await isOnePasswordDesktopActive(account)) {
    return {
      id: "1password",
      label: "1Password",
      available: true,
      signedIn: true,
      authMode: "desktop-app",
      detail: "Authenticated via 1Password desktop app.",
    };
  }

  // Step 2: fall back to the stored session token path.
  const session = await readStoredSession(vault, "1password");
  if (!session) {
    return {
      id: "1password",
      label: "1Password",
      available: true,
      signedIn: false,
      authMode: null,
      detail:
        "`op` is installed but not signed in. Enable 1Password desktop app integration (Settings → Developer → Integrate with 1Password CLI) or use the Sign-in button.",
    };
  }
  const accountArg = account ? [`--account=${account}`] : [];
  try {
    await exec("op", [...accountArg, "whoami", `--session=${session}`], {
      timeout: 3000,
    });
    return {
      id: "1password",
      label: "1Password",
      available: true,
      signedIn: true,
      authMode: "session-token",
    };
  } catch {
    return {
      id: "1password",
      label: "1Password",
      available: true,
      signedIn: false,
      authMode: null,
      detail: "Stored 1Password session is no longer valid. Sign in again.",
    };
  }
}

/** Read the first registered 1Password account shorthand, or null. */
async function readDefaultOpAccount(): Promise<string | null> {
  try {
    const { stdout } = await exec("op", ["account", "list", "--format=json"], {
      timeout: 3000,
      encoding: "utf8",
    });
    const accounts = JSON.parse(stdout) as Array<{
      shorthand?: string;
      url?: string;
    }>;
    for (const a of accounts) {
      if (typeof a.shorthand === "string" && a.shorthand.length > 0) {
        return a.shorthand;
      }
      if (typeof a.url === "string") {
        const sub = a.url.split(".")[0];
        if (sub) return sub;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True when a real vault query succeeds without a session token — i.e.
 * 1Password desktop app integration is active. `op whoami` is unusable
 * here: even with desktop integration active it exits 1 demanding a
 * session token. A vault list query IS handled by desktop session
 * delegation, so probe with that instead. Requires a known account.
 */
async function isOnePasswordDesktopActive(
  account: string | null,
): Promise<boolean> {
  if (!account) return false;
  try {
    await exec(
      "op",
      [`--account=${account}`, "vault", "list", "--format=json"],
      { timeout: 3000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function detectProtonPass(): Promise<BackendStatus> {
  const present = await isCommandAvailable("protonpass-cli");
  return {
    id: "protonpass",
    label: "Proton Pass",
    available: present,
    authMode: null,
    detail: present
      ? "Detected; reference storage will be wired when the vendor CLI stabilizes."
      : "`protonpass-cli` not installed (vendor CLI is in beta).",
  };
}

async function detectBitwarden(vault: Vault): Promise<BackendStatus> {
  const present = await isCommandAvailable("bw");
  if (!present) {
    return {
      id: "bitwarden",
      label: "Bitwarden",
      available: false,
      detail: "`bw` CLI not installed. https://bitwarden.com/help/cli/",
      authMode: null,
    };
  }
  const session = await readStoredSession(vault, "bitwarden");
  const env = session ? { ...process.env, BW_SESSION: session } : process.env;
  try {
    const { stdout } = await exec("bw", ["status"], {
      timeout: 3000,
      encoding: "utf8",
      env,
    });
    const status = JSON.parse(stdout.trim()) as { status?: string };
    if (status.status === "unlocked") {
      return {
        id: "bitwarden",
        label: "Bitwarden",
        available: true,
        signedIn: true,
        authMode: session ? "session-token" : null,
      };
    }
    return {
      id: "bitwarden",
      label: "Bitwarden",
      available: true,
      signedIn: false,
      authMode: null,
      detail: session
        ? "Stored Bitwarden session is no longer valid. Sign in again."
        : status.status === "locked"
          ? "`bw` is signed in but locked. Use the Sign-in button."
          : "`bw` is installed but not signed in. Use the Sign-in button.",
    };
  } catch {
    return {
      id: "bitwarden",
      label: "Bitwarden",
      available: true,
      signedIn: false,
      authMode: null,
      detail: "`bw status` failed; CLI may need an update.",
    };
  }
}

function mapExternalReveal(out: ExternalLoginReveal): UnifiedLoginReveal {
  return {
    source: out.source,
    identifier: out.externalId,
    username: out.username,
    password: out.password,
    domain: out.domain,
    ...(out.totp ? { totp: out.totp } : {}),
  };
}

interface ListExternalOk {
  readonly ok: true;
  readonly entries: readonly ExternalLoginListEntry[];
}
interface ListExternalErr {
  readonly ok: false;
  readonly message: string;
}

async function safeListExternal(
  _source: "1password" | "bitwarden",
  fn: () => Promise<readonly ExternalLoginListEntry[]>,
): Promise<ListExternalOk | ListExternalErr> {
  try {
    const entries = await fn();
    return { ok: true, entries };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
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
