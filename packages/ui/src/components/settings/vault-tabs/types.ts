/**
 * Shared wire types and props for the Vault modal's per-tab panes.
 *
 * Wire shapes mirror `@elizaos/vault` exactly. The Vault modal fetches
 * each piece once on open and forwards everything via props so each tab
 * never re-fetches data the modal already has.
 */

export type BackendId = "in-house" | "1password" | "protonpass" | "bitwarden";
export type InstallableBackendId = Exclude<BackendId, "in-house">;

export interface BackendStatus {
  id: BackendId;
  label: string;
  available: boolean;
  signedIn?: boolean;
  detail?: string;
  /**
   * Auth path used by this backend: `desktop-app` (1Password 8 native
   * app integration), `session-token` (legacy stored session), or null
   * (not signed in / not applicable). Drives a badge on the row so the
   * user sees at a glance which mode is live.
   */
  authMode?: "desktop-app" | "session-token" | null;
}

export interface ManagerPreferences {
  enabled: BackendId[];
  routing?: Record<string, BackendId>;
}

export type InstallMethod =
  | { kind: "brew"; package: string; cask: boolean }
  | { kind: "npm"; package: string }
  | { kind: "manual"; instructions: string; url: string };

// ── Vault inventory wire types ────────────────────────────────────

export type VaultEntryCategory =
  | "provider"
  | "plugin"
  | "wallet"
  | "credential"
  | "system"
  | "session";

export interface VaultEntryProfile {
  id: string;
  label: string;
  createdAt?: number;
}

export interface VaultEntryMeta {
  key: string;
  category: VaultEntryCategory;
  label: string;
  providerId?: string;
  hasProfiles: boolean;
  activeProfile?: string;
  profiles?: VaultEntryProfile[];
  lastModified?: number;
  lastUsed?: number;
  kind: "secret" | "value" | "reference";
}

// ── Routing config wire types ─────────────────────────────────────

export type RoutingScopeKind = "agent" | "app" | "skill";

export interface RoutingScope {
  kind: RoutingScopeKind;
  agentId?: string;
  appName?: string;
  skillId?: string;
}

export interface RoutingRule {
  keyPattern: string;
  scope: RoutingScope;
  profileId: string;
}

export interface RoutingConfig {
  rules: RoutingRule[];
  defaultProfile?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
}

export interface InstalledApp {
  name: string;
  displayName?: string;
}

// ── Saved logins wire types ───────────────────────────────────────

export type SavedLoginSource = "in-house" | "1password" | "bitwarden";

export interface UnifiedSavedLogin {
  source: SavedLoginSource;
  identifier: string;
  domain: string | null;
  username: string;
  title: string;
  updatedAt: number;
}

export interface SavedLoginsListFailure {
  source: "1password" | "bitwarden";
  message: string;
}

// ── Cross-tab navigation contract ─────────────────────────────────

/**
 * Each tab receives a `navigate` callback so it can request a jump to
 * another tab with optional focus parameters. The modal owns the
 * active-tab state and applies the focus on the receiving side.
 */
export type VaultTabNavigate = (target: {
  tab: "overview" | "secrets" | "logins" | "routing";
  focusKey?: string;
  focusProfileId?: string;
}) => void;
