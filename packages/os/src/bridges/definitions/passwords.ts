// spec/os/android/passwords/vault.md, "Story: Keep secrets typed only in an unlocked page"; spec/os/android/passwords/vault.md, "Story: Keep revealed and copied passwords with their current owner"; spec/os/android/passwords/autofill.md, "Story: Fill a form only for its site, from my choice"
export type PasswordBindingKind = "web" | "android";

export interface PasswordBinding {
  kind: PasswordBindingKind;
  facet: string;
  display: string;
}

export interface PasswordEntrySummary {
  id: string;
  label: string;
  username: string;
  bindings: PasswordBinding[];
  updatedAt: number;
  revision: number;
}

export type PasswordAutofillSelection =
  | "this-app"
  | "other"
  | "none"
  | "unknown";

export interface PasswordsStatus {
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
  id?: string;
  label: string;
  username: string;
  websites: string[];
  keepBindings?: string[];
  password?: string;
  generate?: PasswordGenerateOptions;
}

export interface PasswordSaveResult {
  id: string;
  generated?: true;
  length?: number;
}

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
  | "not-admitted"
  | "legacy-authorization-required"
  | "legacy-key-unavailable"
  | "unavailable";

export interface ElizaPasswordsPlugin {
  status(): Promise<PasswordsStatus>;
  unlock(): Promise<{ unlocked: true; unlockRemainingMs: PasswordsStatus["unlockRemainingMs"] }>;
  lock(): Promise<{ locked: true }>;
  list(): Promise<{ entries: PasswordEntrySummary[] }>;
  save(input: PasswordSaveInput): Promise<PasswordSaveResult>;
  openEditor(input?: PasswordEditorInput): Promise<PasswordEditorResult>;
  remove(input: { id: string; expectedRevision?: number }): Promise<{ removed: true }>;
  reset(): Promise<{ reset: true }>;
  reveal(input: { id: string; expectedRevision?: number }): Promise<{ shown: true; hidesAfterMs: number }>;
  copy(input: { id: string; expectedRevision?: number }): Promise<{ copied: true; clearsAfterMs: number }>;
  openAutofillSettings(): Promise<{ status: "opened"; destination: "autofill-picker" | "system-settings" }>;
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
