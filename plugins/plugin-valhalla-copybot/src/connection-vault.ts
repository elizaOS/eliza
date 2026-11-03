import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptSecret, encryptSecret, type KeystoreFile } from "./keystore.ts";
import { redactSecrets, redactUrl } from "./net.ts";

export const CONNECTION_IDS = [
  "birdeye",
  "dexscreener",
  "helius",
  "x",
  "telegram",
  "discord",
  "rugcheck",
  "sheets",
  "coinbase",
  "kraken",
  "binance",
] as const;

export type ConnectionId = (typeof CONNECTION_IDS)[number];

export const ALERT_EVENTS = ["buy", "sell", "freeze", "stall", "pnl"] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

type Sealed = Omit<KeystoreFile, "version" | "publicKey">;

interface VaultFile {
  version: 1;
  items: Array<{ id: ConnectionId; sealed: Sealed }>;
}

export interface ConnectionStatus {
  id: ConnectionId;
  label: string;
  needsKey: boolean;
  state: "off" | "locked" | "ready";
  lastOk: boolean | null;
  lastMessage: string;
}

const LABELS: Record<ConnectionId, string> = {
  birdeye: "Birdeye",
  dexscreener: "DexScreener",
  helius: "Helius",
  x: "X",
  telegram: "Telegram",
  discord: "Discord",
  rugcheck: "RugCheck",
  sheets: "Google Sheets",
  coinbase: "Coinbase",
  kraken: "Kraken",
  binance: "Binance",
};

const NO_KEY = new Set<ConnectionId>(["dexscreener", "rugcheck"]);

export function isConnectionId(value: string): value is ConnectionId {
  return (CONNECTION_IDS as readonly string[]).includes(value);
}

/** Strip keys before a line can be logged or shown. */
export function publicText(text: string): string {
  return redactSecrets(text)
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(/(api[-_]?key|secret|token|password)["']?\s*[:=]\s*\S+/gi, "$1 [redacted]")
    .replace(/https?:\/\/\S+/g, (url) => redactUrl(url));
}

export class ConnectionVault {
  private readonly memory = new Map<ConnectionId, string>();
  private readonly notes = new Map<ConnectionId, { ok: boolean; message: string }>();
  toggles: Record<AlertEvent, boolean> = {
    buy: true,
    sell: true,
    freeze: true,
    stall: true,
    pnl: true,
  };

  constructor(readonly dataDir: string) {}

  private file(): string {
    return path.join(this.dataDir, "connections.vault.json");
  }

  private async readFile(): Promise<VaultFile> {
    try {
      const parsed = JSON.parse(await readFile(this.file(), "utf8")) as VaultFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) return { version: 1, items: [] };
      return parsed;
    } catch {
      return { version: 1, items: [] };
    }
  }

  private async writeFileSafe(file: VaultFile): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.file(), JSON.stringify(file), { mode: 0o600 });
  }

  async connect(id: ConnectionId, secret: string, password: string): Promise<void> {
    if (!NO_KEY.has(id) && secret.trim().length < 8) throw new Error("That key looks too short.");
    const stored = NO_KEY.has(id) ? "enabled" : secret.trim();
    const sealed = await encryptSecret(stored, password);
    const file = await this.readFile();
    const items = file.items.filter((item) => item.id !== id);
    items.push({ id, sealed });
    await this.writeFileSafe({ version: 1, items });
    this.memory.set(id, stored);
    this.notes.set(id, { ok: true, message: "Saved on this PC. The key is encrypted." });
  }

  async unlock(password: string): Promise<void> {
    const file = await this.readFile();
    for (const item of file.items) {
      const plain = await decryptSecret(
        { version: 1, publicKey: "connections", ...item.sealed },
        password
      );
      this.memory.set(item.id, plain);
    }
  }

  async disconnect(id: ConnectionId): Promise<void> {
    const file = await this.readFile();
    await this.writeFileSafe({ version: 1, items: file.items.filter((item) => item.id !== id) });
    this.memory.delete(id);
    this.notes.set(id, { ok: false, message: "Disconnected." });
  }

  secret(id: ConnectionId): string | null {
    return this.memory.get(id) ?? null;
  }

  mark(id: ConnectionId, ok: boolean, message: string): void {
    this.notes.set(id, { ok, message: publicText(message).slice(0, 180) });
  }

  status(): ConnectionStatus[] {
    return CONNECTION_IDS.map((id) => {
      const note = this.notes.get(id);
      const inMemory = this.memory.has(id);
      return {
        id,
        label: LABELS[id],
        needsKey: !NO_KEY.has(id),
        state: inMemory ? "ready" : "off",
        lastOk: note ? note.ok : null,
        lastMessage: note?.message ?? (NO_KEY.has(id) ? "No key required." : "Not connected."),
      };
    });
  }

  async wipeFile(): Promise<void> {
    this.memory.clear();
    await unlink(this.file()).catch(() => undefined);
  }
}
