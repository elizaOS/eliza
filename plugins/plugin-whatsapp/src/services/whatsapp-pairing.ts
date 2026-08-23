/**
 * WhatsApp pairing service — manages Baileys sessions for QR code authentication.
 *
 * This service is separate from `@elizaos/plugin-whatsapp` because the plugin
 * initializes during runtime startup (too late for interactive QR flow).
 * Once pairing succeeds, the auth state is persisted to disk so the plugin
 * can reconnect automatically on subsequent startups.
 */

import { logger as coreLogger } from "@elizaos/core";
import {
  loadDurableBaileysAuthState,
  removeDurableBaileysAuthState,
  validateWhatsAppAccountId,
  whatsappDurableAuthExists,
} from "../baileys/auth";

const LOG_PREFIX = "[whatsapp-pairing]";

/** Validate accountId to prevent path traversal. Only allows alphanumeric, dash, underscore. */
export function sanitizeAccountId(raw: string): string {
  return validateWhatsAppAccountId(raw);
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
  private stopped = false;
  private lifecycleEpoch = 0;
  private qrSequence = 0;
  private credentialSaveTail: Promise<void> = Promise.resolve();
  private teardownTail: Promise<void> = Promise.resolve();

  constructor(options: WhatsAppPairingOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    await this.stop();
    this.stopped = false;
    const epoch = ++this.lifecycleEpoch;
    await this.startAttempt(epoch);
  }

  private async startAttempt(epoch: number): Promise<void> {
    await Promise.all([this.credentialSaveTail, this.teardownTail]);
    if (!this.isActiveEpoch(epoch)) return;
    this.setStatus("initializing");

    const baileys = await import("@whiskeysockets/baileys");
    const makeWASocket = baileys.default;
    const { fetchLatestBaileysVersion, DisconnectReason } = baileys;
    const QRCode = (await import("qrcode")).default;
    const { Boom } = await import("@hapi/boom");

    const { state, saveCreds } = await loadDurableBaileysAuthState(
      this.options.accountId,
      this.options.authDir
    );
    const { version } = await fetchLatestBaileysVersion();

    const pino = (await import("pino")).default;
    const baileysLogger = pino({ level: "silent" });

    // stop() may have run while the awaits above were in flight -- don't
    // resurrect a socket for a session the caller already tore down.
    if (!this.isActiveEpoch(epoch)) {
      return;
    }

    const socket = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false,
      browser: ["Eliza AI", "Desktop", "1.0.0"],
    });
    this.socket = socket;

    socket.ev.on("creds.update", () => {
      if (!this.isActiveSocket(epoch, socket)) return;
      const save = this.credentialSaveTail.then(async () => {
        await saveCreds();
      });
      this.credentialSaveTail = save.catch((error) => {
        // error-policy:J1 The Baileys event boundary observes asynchronous credential-save failure.
        coreLogger.error(`${LOG_PREFIX} Credential save failed: ${String(error)}`);
      });
    });

    socket.ev.on("connection.update", async (update) => {
      if (!this.isActiveSocket(epoch, socket)) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrSequence = ++this.qrSequence;
        this.qrAttempts++;
        coreLogger.info(
          `${LOG_PREFIX} QR code received (attempt ${this.qrAttempts}/${this.MAX_QR_ATTEMPTS})`
        );
        if (this.qrAttempts > this.MAX_QR_ATTEMPTS) {
          this.setStatus("timeout");
          void this.stop();
          return;
        }

        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 256,
            margin: 2,
            color: { dark: "#000000", light: "#ffffff" },
          });
          if (!this.isActiveSocket(epoch, socket) || this.qrSequence !== qrSequence) return;

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
        coreLogger.info(
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
          coreLogger.info(`${LOG_PREFIX} Restarting pairing after transient close...`);
          this.socket = null;
          this.qrAttempts = 0;
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (!this.isActiveEpoch(epoch)) return;
            this.startAttempt(epoch).catch((err) => {
              if (!this.isActiveEpoch(epoch)) return;
              coreLogger.error(`${LOG_PREFIX} Restart failed: ${String(err)}`);
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
        const phoneNumber = socket.user?.id?.split(":")[0] ?? "";
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

  async stop(): Promise<void> {
    this.stopped = true;
    this.lifecycleEpoch++;
    this.qrSequence++;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    let socketTeardown: Promise<void> = Promise.resolve();
    try {
      socketTeardown = Promise.resolve(socket?.end(undefined)).catch((error) => {
        // error-policy:J6 Pairing socket teardown is best-effort but must be observed.
        coreLogger.warn(`${LOG_PREFIX} Socket teardown failed: ${String(error)}`);
      });
    } catch (error) {
      // error-policy:J6 Pairing socket teardown is best-effort but must be observed.
      coreLogger.warn(`${LOG_PREFIX} Socket teardown failed: ${String(error)}`);
    }

    const previousTeardown = this.teardownTail;
    this.teardownTail = Promise.all([
      previousTeardown,
      this.credentialSaveTail,
      socketTeardown,
    ]).then(() => undefined);
    await this.teardownTail;
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

  private isActiveEpoch(epoch: number): boolean {
    return !this.stopped && this.lifecycleEpoch === epoch;
  }

  private isActiveSocket(
    epoch: number,
    socket: ReturnType<typeof import("@whiskeysockets/baileys").default>
  ): boolean {
    return this.isActiveEpoch(epoch) && this.socket === socket;
  }
}

export function whatsappAuthExists(accountId = "default"): Promise<boolean> {
  return whatsappDurableAuthExists(accountId);
}

export async function whatsappLogout(accountId = "default"): Promise<void> {
  try {
    if (await whatsappDurableAuthExists(accountId)) {
      const baileys = await import("@whiskeysockets/baileys");
      const makeWASocket = baileys.default;
      const { fetchLatestBaileysVersion } = baileys;
      const pino = (await import("pino")).default;
      const logger = pino({ level: "silent" });

      const { state } = await loadDurableBaileysAuthState(accountId);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
      });

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = async () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          try {
            sock.ev.removeAllListeners("connection.update");
          } catch (error) {
            // error-policy:J6 Listener removal is best-effort during logout teardown.
            coreLogger.warn(`${LOG_PREFIX} Logout listener cleanup failed: ${String(error)}`);
          }
          try {
            await sock.end(undefined);
          } catch (error) {
            // error-policy:J6 Socket closure is best-effort after the logout result is known.
            coreLogger.warn(`${LOG_PREFIX} Logout socket teardown failed: ${String(error)}`);
          }
          resolve();
        };

        const timeout = setTimeout(() => void finish(), 10_000);

        sock.ev.on("connection.update", async (update) => {
          if (update.connection === "open") {
            try {
              await sock.logout();
            } catch {
              // error-policy:J6 The remote session may already be logged out.
              // May fail if already logged out remotely.
            }
            await finish();
          } else if (update.connection === "close") {
            await finish();
          }
        });
      });
    }
  } catch {
    // error-policy:J6 Remote logout and snapshot loading are best-effort; local removal separately proves ownership.
    coreLogger.warn(`${LOG_PREFIX} Remote logout unavailable for account ${accountId}`);
  }

  await removeDurableBaileysAuthState(accountId);
}
