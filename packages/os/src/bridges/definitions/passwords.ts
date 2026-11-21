/**
 * Vault management contract for a host's own password UI. Every response is metadata:
 * no method resolves with a password, passkey or one-time-code secret. Passwords travel only
 * from the user's own typing into native code (write-only) or are generated natively.
 */
export type PasswordBindingKind = "web" | "android";

export interface PasswordBinding {
  kind: PasswordBindingKind;
  /** `https://host[:port]` or `android://<sha256 hex>@<package>`. Not a secret. */
  facet: string;
  /** Host name or app label for display. */
  display: string;
}

export interface PasswordEntrySummary {
  id: string;
  label: string;
  username: string;
  bindings: PasswordBinding[];
  updatedAt: number;
  /** Pass to `openEditor` to edit this entry. Changes on every write; 0 for an older record. */
  revision: number;
}

export type PasswordAutofillSelection =
  | "this-app"
  | "other"
  | "none"
  | "unknown";

export interface PasswordsStatus {
  /** Whether the current native custody policy permits access. */
  available: boolean;
  reason?: "no-screen-lock" | "unsupported" | "not-admitted" | "device-locked" | "legacy-authorization-required" | "legacy-key-unavailable";
  custody?: "device-unlocked";
  locked: boolean;
  unlockRemainingMs: number | null;
  unlockSeconds: number;
  biometric: boolean;
  autofill: { supported: boolean | null; selected: PasswordAutofillSelection };
}

export interface PasswordGenerateOptions {
  length?: number;
  lowercase?: boolean;
  uppercase?: boolean;
  digits?: boolean;
  symbols?: boolean;
}

export interface PasswordSaveInput {
  /** Omit to create. */
  id?: string;
  label: string;
  username: string;
  /** HTTPS origins to bind. */
  websites: string[];
  /** Existing facets to keep, including app bindings created by a save capture. */
  keepBindings?: string[];
  /** Write-only. Omit on update to keep the stored password. */
  password?: string;
  /** Generate natively instead of supplying `password`. */
  generate?: PasswordGenerateOptions;
}

export interface PasswordSaveResult {
  id: string;
  generated?: true;
  length?: number;
}

/** Names one entry at the revision the UI read. */
export interface PasswordEditorInput {
  entryId: string;
  expectedRevision: number;
}

export type PasswordEditorResult =
  | { status: "saved"; id: string; revision: number }
  | { status: "cancelled" };

export type PasswordsErrorCode =
  | "locked"
  | "cancelled"
  | "no-screen-lock"
  | "invalid"
  | "key-invalidated"
  | "busy"
  | "conflict"
  /** The host's admission rule refused this vault entry (see the README). */
  | "not-admitted"
  | "unavailable";

export interface ElizaPasswordsPlugin {
  status(): Promise<PasswordsStatus>;
  unlock(): Promise<{ unlocked: true; unlockRemainingMs: number | null }>;
  lock(): Promise<{ locked: true }>;
  list(): Promise<{ entries: PasswordEntrySummary[] }>;
  save(input: PasswordSaveInput): Promise<PasswordSaveResult>;
  /**
   * Native protected form. No input creates an entry; `PasswordEditorInput` edits one and rejects
   * with `conflict` if it changed since that revision. No secret or draft crosses the bridge.
   */
  openEditor(input?: PasswordEditorInput): Promise<PasswordEditorResult>;
  remove(input: { id: string; expectedRevision?: number }): Promise<{ removed: true }>;
  /**
   * Deletes the vault only when it can never be decrypted again (its key was lost or
   * permanently invalidated, reported as `key-invalidated`). Requires an unlock; a readable
   * vault is refused with `invalid`.
   */
  reset(): Promise<{ reset: true }>;
  /** Native FLAG_SECURE dialog. Resolves with an acknowledgement, never the value. */
  reveal(input: { id: string; expectedRevision?: number }): Promise<{ shown: true; hidesAfterMs: number }>;
  /** Native sensitive clipboard copy, cleared later if still the copied clip. */
  copy(input: { id: string; expectedRevision?: number }): Promise<{ copied: true; clearsAfterMs: number }>;
  /** Opens Android's own autofill-provider confirmation. Selection is read back by status(). */
  openAutofillSettings(): Promise<{
    status: "opened";
    destination: "autofill-picker" | "system-settings";
  }>;
}

export interface PasswordExportResult {
  exported: number;
}

export interface PasswordImportResult {
  imported: number;
  skipped: number;
}

export interface ElizaPasswordTransferPlugin {
  exportVault(): Promise<PasswordExportResult>;
  importVault(): Promise<PasswordImportResult>;
}
