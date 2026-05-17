/**
 * Vault domain methods — saved-login autofill for the in-app browser.
 *
 * Mirrors the wallet-shim contract: the in-tab preload sends
 * `__elizaVaultAutofillRequest` to the host, the host calls these
 * methods, then replies via `tag.executeJavascript("window.__elizaVaultReply(...)")`.
 *
 * The list endpoint aggregates entries from every signed-in backend:
 * in-house vault, 1Password, and Bitwarden. Each entry carries a
 * `source` + `identifier` pair so callers can reveal credentials
 * uniformly via `revealSavedLogin(source, identifier)`.
 */
export type SavedLoginSource = "in-house" | "1password" | "bitwarden";
export interface SavedLoginListRecord {
  source: SavedLoginSource;
  identifier: string;
  domain: string | null;
  username: string;
  title: string;
  updatedAt: number;
}
export interface SavedLoginListFailure {
  source: "1password" | "bitwarden";
  message: string;
}
export interface SavedLoginRevealRecord {
  source: SavedLoginSource;
  identifier: string;
  username: string;
  password: string;
  totp?: string;
  domain: string | null;
}
declare module "./client-base" {
  interface ElizaClient {
    listSavedLogins(domain?: string): Promise<{
      logins: readonly SavedLoginListRecord[];
      failures: readonly SavedLoginListFailure[];
    }>;
    revealSavedLogin(
      source: SavedLoginSource,
      identifier: string,
    ): Promise<SavedLoginRevealRecord>;
    saveSavedLogin(input: {
      domain: string;
      username: string;
      password: string;
      otpSeed?: string;
      notes?: string;
    }): Promise<void>;
    deleteSavedLogin(domain: string, username: string): Promise<void>;
    getAutofillAllowed(domain: string): Promise<boolean>;
    setAutofillAllowed(domain: string, allowed: boolean): Promise<void>;
  }
}
//# sourceMappingURL=client-vault.d.ts.map
