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
}

export type PasswordAutofillSelection =
  | "this-app"
  | "other"
  | "none"
  | "unknown";

export interface PasswordsStatus {
  /** False when the device has no secure screen lock or the platform is unsupported. */
  available: boolean;
  reason?: "no-screen-lock" | "unsupported";
  locked: boolean;
  unlockRemainingMs: number;
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

export type PasswordsErrorCode =
  | "locked"
  | "cancelled"
  | "no-screen-lock"
  | "invalid"
  | "key-invalidated"
  | "busy"
  | "unavailable";

export interface ElizaPasswordsPlugin {
  status(): Promise<PasswordsStatus>;
  /** Shows the platform BiometricPrompt (strong biometric or device credential). */
  unlock(): Promise<{ unlocked: true; unlockRemainingMs: number }>;
  lock(): Promise<{ locked: true }>;
  list(): Promise<{ entries: PasswordEntrySummary[] }>;
  save(input: PasswordSaveInput): Promise<PasswordSaveResult>;
  remove(input: { id: string }): Promise<{ removed: true }>;
  /**
   * Deletes the vault only when it can never be decrypted again (its key was lost or
   * permanently invalidated, reported as `key-invalidated`). Requires an unlock; a readable
   * vault is refused with `invalid`.
   */
  reset(): Promise<{ reset: true }>;
  /** Native FLAG_SECURE dialog. Resolves with an acknowledgement, never the value. */
  reveal(input: { id: string }): Promise<{ shown: true; hidesAfterMs: number }>;
  /** Native sensitive clipboard copy, cleared later if still the copied clip. */
  copy(input: { id: string }): Promise<{ copied: true; clearsAfterMs: number }>;
  /** Opens Android's own autofill-provider confirmation. Selection is read back by status(). */
  openAutofillSettings(): Promise<{
    status: "opened";
    destination: "autofill-picker" | "system-settings";
  }>;
}
