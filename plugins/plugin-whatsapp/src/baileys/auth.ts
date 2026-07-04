/**
 * Wraps Baileys' multi-file auth state for a single account: loads and persists
 * credentials under a given directory so a paired personal WhatsApp session can
 * reconnect across restarts. Owned by BaileysConnection / BaileysClient.
 */
import type { AuthenticationState } from "@whiskeysockets/baileys";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";

export class BaileysAuthManager {
  private readonly authDir: string;
  private state?: AuthenticationState;
  private saveCreds?: () => Promise<void>;

  constructor(authDir: string) {
    this.authDir = authDir;
  }

  async initialize(): Promise<AuthenticationState> {
    const result = await useMultiFileAuthState(this.authDir);
    this.state = result.state;
    this.saveCreds = result.saveCreds;
    return this.state;
  }

  async save(): Promise<void> {
    if (this.saveCreds) {
      await this.saveCreds();
    }
  }
}
