/**
 * WhatsApp pairing service — manages Baileys sessions for QR code authentication.
 *
 * This service is separate from the main WhatsApp plugin because the plugin
 * initializes during runtime startup (too late for interactive QR flow).
 * Once pairing succeeds, the auth state is persisted to disk so the plugin
 * can reconnect automatically on subsequent startups.
 */

import fs from "node:fs";
import path from "node:path";

const LOG_PREFIX = "[whatsapp-pairing]";

/** Validate accountId to prevent path traversal. Only allows alphanumeric, dash, underscore. */
export function sanitizeAccountId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!cleaned || cleaned !== raw) {
    throw new Error(
      `Invalid accountId: must only contain alphanumeric characters, dashes, and underscores`
    );
  }
  return cleaned;
}

export type WhatsAppPairingStatus =
  | "idle"
  | "initializing"
  | "waiting_for_qr"
  | "connected"
  | "disconnected"
  | "timeout"
  | "error";

export interface WhatsAppPairingEvent {
  type: "whatsapp-qr" | "whatsapp-status";
  accountId: string;
  qrDataUrl?: string;
  expiresInMs?: number;
  status?: WhatsAppPairingStatus;
  phoneNumber?: string;
  error?: string;
}

export interface WhatsAppPairingOptions {
  authDir: string;
  accountId: string;
  onEvent: (event: WhatsAppPairingEvent) => void;
}

export class WhatsAppPairingSession {
  private socket: ReturnType<typeof import("@whiskeysockets/baileys").default> | null = null;
  private status: WhatsAppPairingStatus = "idle";
  private options: WhatsAppPairingOptions;
  private qrAttempts = 0;
  private readonly MAX_QR_ATTEMPTS = 5;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WhatsAppPairingOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.setStatus("initializing");

    const baileys = await import("@whiskeysockets/baileys");
    const makeWASocket = baileys.default;
    const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = baileys;
    const QRCode = (await import("qrcode")).default;
    const { Boom } = await import("@hapi/boom");

    fs.mkdirSync(this.options.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.options.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const pino = (await import("pino")).default;
    const baileysLogger = pino({ level: "silent" });

    this.socket = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false,
      browser: ["Eliza AI", "Desktop", "1.0.0"],
    });

    this.socket.ev.on("creds.update", saveCreds);

    this.socket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrAttempts++;
        console.info(
          `${LOG_PREFIX} QR code received (attempt ${this.qrAttempts}/${this.MAX_QR_ATTEMPTS})`
        );
        if (this.qrAttempts > this.MAX_QR_ATTEMPTS) {
          this.setStatus("timeout");
          this.stop();
          return;
        }

        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 256,
            margin: 2,
            color: { dark: "#000000", light: "#ffffff" },
          });

          this.setStatus("waiting_for_qr");
          this.options.onEvent({
            type: "whatsapp-qr",
            accountId: this.options.accountId,
            qrDataUrl,
            expiresInMs: 20_000,
          });
        } catch {
          // QR generation failure — non-fatal, next QR attempt will retry.
        }
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as InstanceType<typeof Boom>)?.output?.statusCode;
        console.info(
          `${LOG_PREFIX} Connection closed, statusCode=${statusCode}, status=${this.status}`
        );
        if (statusCode === DisconnectReason.loggedOut) {
          this.setStatus("disconnected");
        } else if (
          statusCode === DisconnectReason.restartRequired ||
          statusCode === DisconnectReason.timedOut ||
          statusCode === DisconnectReason.connectionClosed ||
          statusCode === DisconnectReason.connectionReplaced
        ) {
          console.info(`${LOG_PREFIX} Restarting pairing after transient close...`);
          this.socket = null;
          this.qrAttempts = 0;
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.start().catch((err) => {
              console.error(`${LOG_PREFIX} Restart failed:`, err);
              this.setStatus("error");
              this.options.onEvent({
                type: "whatsapp-status",
                accountId: this.options.accountId,
                status: "error",
                error: String(err),
              });
            });
          }, 3000);
        }
      } else if (connection === "open") {
        const phoneNumber = this.socket?.user?.id?.split(":")[0] ?? "";
        this.setStatus("connected");
        this.options.onEvent({
          type: "whatsapp-status",
          accountId: this.options.accountId,
          status: "connected",
          phoneNumber,
        });
      }
    });
  }

  stop(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      this.socket?.end(undefined);
    } catch {
      // Ignore cleanup errors.
    }
    this.socket = null;
  }

  getStatus(): WhatsAppPairingStatus {
    return this.status;
  }

  private setStatus(status: WhatsAppPairingStatus): void {
    this.status = status;
    this.options.onEvent({
      type: "whatsapp-status",
      accountId: this.options.accountId,
      status,
    });
  }
}

export function whatsappAuthExists(workspaceDir: string, accountId = "default"): boolean {
  const credsPath = path.join(workspaceDir, "whatsapp-auth", accountId, "creds.json");
  return fs.existsSync(credsPath);
}

export async function whatsappLogout(workspaceDir: string, accountId = "default"): Promise<void> {
  const authDir = path.join(workspaceDir, "whatsapp-auth", accountId);
  const credsPath = path.join(authDir, "creds.json");

  if (fs.existsSync(credsPath)) {
    try {
      const baileys = await import("@whiskeysockets/baileys");
      const makeWASocket = baileys.default;
      const { useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;
      const pino = (await import("pino")).default;
      const logger = pino({ level: "silent" });

      const { state } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
      });

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          try {
            sock.ev.removeAllListeners("connection.update");
          } catch {
            /* */
          }
          try {
            sock.end(undefined);
          } catch {
            /* */
          }
          resolve();
        };

        const timeout = setTimeout(finish, 10_000);

        sock.ev.on("connection.update", async (update) => {
          if (update.connection === "open") {
            try {
              await sock.logout();
            } catch {
              // May fail if already logged out remotely.
            }
            finish();
          } else if (update.connection === "close") {
            finish();
          }
        });
      });
    } catch {
      // If Baileys can't connect, just delete files anyway.
    }
  }

  fs.rmSync(authDir, { recursive: true, force: true });
}
