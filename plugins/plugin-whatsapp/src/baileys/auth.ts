/**
 * Wraps Baileys' multi-file auth state for a single account: loads and persists
 * credentials under a given directory so a paired personal WhatsApp session can
 * reconnect across restarts. Owned by BaileysConnection / BaileysClient.
 */

import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AuthenticationState } from "@whiskeysockets/baileys";
import { useMultiFileAuthState as loadMultiFileAuthState } from "@whiskeysockets/baileys";

const AUTH_DIRECTORY_MODE = 0o700;
const AUTH_FILE_MODE = 0o600;

/** Create and validate the private directory that owns one Baileys identity. */
export function prepareBaileysAuthDirectory(authDir: string): void {
  mkdirSync(authDir, { recursive: true, mode: AUTH_DIRECTORY_MODE });
  const info = lstatSync(authDir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`WhatsApp auth path must be a real directory: ${authDir}`);
  }
  chmodSync(authDir, AUTH_DIRECTORY_MODE);
}

/** Tighten every Baileys multi-file credential after the library writes it. */
export function secureBaileysAuthFiles(authDir: string): void {
  prepareBaileysAuthDirectory(authDir);
  for (const entry of readdirSync(authDir, { withFileTypes: true })) {
    const entryPath = path.join(authDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`WhatsApp auth directory must not contain symbolic links: ${entryPath}`);
    }
    chmodSync(entryPath, entry.isDirectory() ? AUTH_DIRECTORY_MODE : AUTH_FILE_MODE);
  }
}

export class BaileysAuthManager {
  private readonly authDir: string;
  private state?: AuthenticationState;
  private saveCreds?: () => Promise<void>;

  constructor(authDir: string) {
    this.authDir = authDir;
  }

  async initialize(): Promise<AuthenticationState> {
    secureBaileysAuthFiles(this.authDir);
    const result = await loadMultiFileAuthState(this.authDir);
    this.state = result.state;
    this.saveCreds = result.saveCreds;
    return this.state;
  }

  async save(): Promise<void> {
    if (this.saveCreds) {
      await this.saveCreds();
      secureBaileysAuthFiles(this.authDir);
    }
  }
}
