/**
 * Signal pairing service — manages device linking via QR code.
 *
 * Mirrors whatsapp-pairing.ts but uses @elizaos/signal-native instead of
 * Baileys. Signal linking produces a single provisioning URL (not a refresh
 * loop) — if it times out, restart the session.
 */

import fs from "node:fs";
import path from "node:path";

const LOG_PREFIX = "[signal-pairing]";
const SIGNAL_NATIVE_MODULE_ID = "@elizaos/signal-native";

/** Validate accountId to prevent path traversal. */
export function sanitizeAccountId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!cleaned || cleaned !== raw) {
    throw new Error(
      `Invalid accountId: must only contain alphanumeric characters, dashes, and underscores`,
    );
  }
  return cleaned;
}

export type SignalPairingStatus =
  | "idle"
  | "initializing"
  | "waiting_for_qr"
  | "connected"
  | "disconnected"
  | "timeout"
  | "error";

export interface SignalPairingEvent {
  type: "signal-qr" | "signal-status";
  accountId: string;
  qrDataUrl?: string;
  status?: SignalPairingStatus;
  uuid?: string;
  phoneNumber?: string;
  error?: string;
}

export interface SignalPairingOptions {
  authDir: string;
  accountId: string;
  onEvent: (event: SignalPairingEvent) => void;
}

interface QrCodeModule {
  toDataURL: (
    text: string,
    options?: Record<string, unknown>,
  ) => Promise<string>;
}

export class SignalPairingSession {
  private status: SignalPairingStatus = "idle";
  private options: SignalPairingOptions;
  private aborted = false;

  constructor(options: SignalPairingOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.aborted = false;
    this.setStatus("initializing");

    let native: typeof import("@elizaos/signal-native");
    let qrCode: QrCodeModule;
    try {
      native = await import(/* @vite-ignore */ SIGNAL_NATIVE_MODULE_ID);
      const importedQrCode = await import("qrcode");
      qrCode = (importedQrCode.default ?? importedQrCode) as QrCodeModule;
    } catch (err) {
      this.setStatus("error");
      this.options.onEvent({
        type: "signal-status",
        accountId: this.options.accountId,
        status: "error",
        error: `Failed to load dependencies: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    fs.mkdirSync(this.options.authDir, { recursive: true });

    try {
      console.info(`${LOG_PREFIX} Starting device linking...`);
      const provisioningUrl = await native.linkDevice(
        this.options.authDir,
        "Eliza AI",
      );

      if (this.aborted) return;

      const qrDataUrl = await qrCode.toDataURL(provisioningUrl, {
        width: 256,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });

      this.setStatus("waiting_for_qr");
      this.options.onEvent({
        type: "signal-qr",
        accountId: this.options.accountId,
        qrDataUrl,
      });

      console.info(
        `${LOG_PREFIX} QR code generated, waiting for user to scan...`,
      );

      await native.finishLink(this.options.authDir);
      if (this.aborted) return;

      let uuid = "";
      let phoneNumber = "";
      try {
        const profile = await native.getProfile(this.options.authDir);
        uuid = profile.uuid;
        phoneNumber = profile.phoneNumber ?? "";
      } catch {
        // Profile fetch is non-critical.
      }

      this.setStatus("connected");
      this.options.onEvent({
        type: "signal-status",
        accountId: this.options.accountId,
        status: "connected",
        uuid,
        phoneNumber,
      });

      console.info(
        `${LOG_PREFIX} Device linked successfully${phoneNumber ? ` (${phoneNumber})` : ""}`,
      );
    } catch (err) {
      if (this.aborted) return;

      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Linking failed:`, errMsg);

      this.setStatus("error");
      this.options.onEvent({
        type: "signal-status",
        accountId: this.options.accountId,
        status: "error",
        error: errMsg,
      });
    }
  }

  stop(): void {
    this.aborted = true;
  }

  getStatus(): SignalPairingStatus {
    return this.status;
  }

  private setStatus(status: SignalPairingStatus): void {
    this.status = status;
    this.options.onEvent({
      type: "signal-status",
      accountId: this.options.accountId,
      status,
    });
  }
}

export function signalAuthExists(
  workspaceDir: string,
  accountId = "default",
): boolean {
  const authDir = path.join(workspaceDir, "signal-auth", accountId);
  return fs.existsSync(authDir);
}

export function signalLogout(
  workspaceDir: string,
  accountId = "default",
): void {
  const authDir = path.join(workspaceDir, "signal-auth", accountId);
  fs.rmSync(authDir, { recursive: true, force: true });
}
