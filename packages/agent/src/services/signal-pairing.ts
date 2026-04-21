/**
 * Signal pairing service — manages device linking via QR code.
 *
 * Mirrors whatsapp-pairing.ts but uses @elizaos/signal-native instead of
 * Baileys. Signal linking produces a single provisioning URL (not a refresh
 * loop) — if it times out, restart the session.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const LOG_PREFIX = "[signal-pairing]";
const SIGNAL_NATIVE_MODULE_ID = "@elizaos/signal-native";
const execFileAsync = promisify(execFile);
const DEFAULT_SIGNAL_CLI_NAME = "signal-cli";
const DEFAULT_SIGNAL_DEVICE_NAME = "Eliza Mac";
const DEFAULT_SIGNAL_CLI_WAIT_TIMEOUT_MS = 30_000;
const BREW_OPENJDK_HOME = "/opt/homebrew/opt/openjdk";
const COMMON_SIGNAL_CLI_PATHS = [
  "/opt/homebrew/bin/signal-cli",
  "/usr/local/bin/signal-cli",
];

type SignalNativeModule = {
  linkDevice: (authDir: string, deviceName: string) => Promise<string>;
  finishLink: (authDir: string) => Promise<void>;
  getProfile: (
    authDir: string,
  ) => Promise<{ uuid: string; phoneNumber?: string | null }>;
};

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

export interface SignalPairingSnapshot {
  status: SignalPairingStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  error: string | null;
}

export interface SignalPairingOptions {
  authDir: string;
  accountId: string;
  cliPath?: string;
  onEvent: (event: SignalPairingEvent) => void;
}

interface QrCodeModule {
  toDataURL: (
    text: string,
    options?: Record<string, unknown>,
  ) => Promise<string>;
}

export function extractSignalCliProvisioningUrl(text: string): string | null {
  const match = text.match(/sgnl:\/\/linkdevice\?[^\s]+/);
  return match?.[0] ?? null;
}

export function parseSignalCliAccountsOutput(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === "string" && entry.trim().length > 0) {
          return entry.trim();
        }
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as Record<string, unknown>).number === "string"
        ) {
          const number = (entry as Record<string, unknown>).number as string;
          if (number.trim().length > 0) {
            return number;
          }
        }
      }
    }
  } catch {
    // Plain-text output fallback handled below.
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const account = line.trim();
    if (account.length > 0) {
      return account;
    }
  }

  return null;
}

async function resolveExecutablePath(binary: string): Promise<string | null> {
  const trimmed = binary.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes("/") || trimmed.startsWith(".")) {
    return fs.existsSync(trimmed) ? trimmed : null;
  }

  try {
    const { stdout } = await execFileAsync("/usr/bin/which", [trimmed]);
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    if (trimmed !== DEFAULT_SIGNAL_CLI_NAME) {
      return null;
    }

    for (const candidate of COMMON_SIGNAL_CLI_PATHS) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }
}

function resolveSignalCliJavaHome(): string | null {
  if (fs.existsSync(BREW_OPENJDK_HOME)) {
    return BREW_OPENJDK_HOME;
  }

  if (
    typeof process.env.JAVA_HOME === "string" &&
    process.env.JAVA_HOME.trim().length > 0
  ) {
    return process.env.JAVA_HOME.trim();
  }

  return null;
}

function buildSignalCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const javaHome = resolveSignalCliJavaHome();

  if (javaHome) {
    env.JAVA_HOME = javaHome;
    const javaBin = path.join(javaHome, "bin");
    env.PATH = env.PATH ? `${javaBin}:${env.PATH}` : javaBin;
  }

  return env;
}

export function classifySignalPairingErrorStatus(
  errorMessage: string,
): SignalPairingStatus {
  return /(timed?\s*out|timeout|expired)/i.test(errorMessage)
    ? "timeout"
    : "error";
}

export class SignalPairingSession {
  private status: SignalPairingStatus = "idle";
  private options: SignalPairingOptions;
  private aborted = false;
  private qrDataUrl: string | null = null;
  private phoneNumber: string | null = null;
  private lastError: string | null = null;
  private activeChild: ChildProcess | null = null;

  constructor(options: SignalPairingOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.aborted = false;
    this.qrDataUrl = null;
    this.phoneNumber = null;
    this.lastError = null;
    this.setStatus("initializing");

    let qrCode: QrCodeModule;
    try {
      const importedQrCode = await import("qrcode");
      qrCode = (importedQrCode.default ?? importedQrCode) as QrCodeModule;
    } catch (err) {
      const message = `Failed to load QR dependency: ${String(err)}`;
      this.lastError = message;
      this.setStatus("error");
      this.options.onEvent({
        type: "signal-status",
        accountId: this.options.accountId,
        status: "error",
        error: message,
      });
      return;
    }

    fs.mkdirSync(this.options.authDir, { recursive: true });

    try {
      const native = await this.loadSignalNativeModule();
      if (native) {
        await this.startWithSignalNative(native, qrCode);
        return;
      }

      await this.startWithSignalCli(qrCode);
    } catch (err) {
      if (this.aborted) return;

      const errMsg = String(err);
      console.error(`${LOG_PREFIX} Linking failed:`, errMsg);

      this.qrDataUrl = null;
      this.lastError = errMsg;
      const status = classifySignalPairingErrorStatus(errMsg);
      this.setStatus(status);
      this.options.onEvent({
        type: "signal-status",
        accountId: this.options.accountId,
        status,
        error: errMsg,
      });
    }
  }

  stop(): void {
    this.aborted = true;
    this.activeChild?.kill("SIGTERM");
    this.activeChild = null;
  }

  getStatus(): SignalPairingStatus {
    return this.status;
  }

  getSnapshot(): SignalPairingSnapshot {
    return {
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      phoneNumber: this.phoneNumber,
      error: this.lastError,
    };
  }

  private setStatus(status: SignalPairingStatus): void {
    this.status = status;
    this.options.onEvent({
      type: "signal-status",
      accountId: this.options.accountId,
      status,
    });
  }

  private async loadSignalNativeModule(): Promise<SignalNativeModule | null> {
    try {
      const moduleSpecifier: string = SIGNAL_NATIVE_MODULE_ID;
      const imported = await import(/* @vite-ignore */ moduleSpecifier);
      return imported as SignalNativeModule;
    } catch (error) {
      console.info(
        `${LOG_PREFIX} Signal native module unavailable, using signal-cli pairing: ${String(error)}`,
      );
      return null;
    }
  }

  private async startWithSignalNative(
    native: SignalNativeModule,
    qrCode: QrCodeModule,
  ): Promise<void> {
    console.info(`${LOG_PREFIX} Starting device linking with signal-native...`);
    const provisioningUrl = await native.linkDevice(
      this.options.authDir,
      DEFAULT_SIGNAL_DEVICE_NAME,
    );

    if (this.aborted) return;

    const qrDataUrl = await qrCode.toDataURL(provisioningUrl, {
      width: 256,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });

    this.qrDataUrl = qrDataUrl;
    this.lastError = null;
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
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Failed to read Signal profile after linking: ${String(error)}`,
      );
    }

    this.finishConnected(phoneNumber || null, uuid || undefined);
  }

  private async startWithSignalCli(qrCode: QrCodeModule): Promise<void> {
    const cliPath = await resolveExecutablePath(
      this.options.cliPath?.trim() ||
        process.env.SIGNAL_CLI_PATH ||
        DEFAULT_SIGNAL_CLI_NAME,
    );

    if (!cliPath) {
      throw new Error(
        `Failed to load dependencies: Cannot find ${this.options.cliPath?.trim() || DEFAULT_SIGNAL_CLI_NAME}`,
      );
    }

    console.info(`${LOG_PREFIX} Starting device linking with signal-cli...`);

    const child = spawn(
      cliPath,
      [
        "--config",
        this.options.authDir,
        "link",
        "-n",
        DEFAULT_SIGNAL_DEVICE_NAME,
      ],
      {
        env: buildSignalCliEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.activeChild = child;

    const stderrLines: string[] = [];
    let provisioningUrl: string | null = null;
    const waitForProvisioningUrl = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `signal-cli link did not emit a provisioning URL within ${DEFAULT_SIGNAL_CLI_WAIT_TIMEOUT_MS}ms`,
          ),
        );
      }, DEFAULT_SIGNAL_CLI_WAIT_TIMEOUT_MS);

      const onLine = (line: string, source: "stdout" | "stderr"): void => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        const extracted = extractSignalCliProvisioningUrl(trimmed);
        if (extracted) {
          provisioningUrl = extracted;
          clearTimeout(timer);
          resolve(extracted);
          return;
        }
        if (source === "stderr") {
          stderrLines.push(trimmed);
        }
      };

      const stdoutReader = createInterface({ input: child.stdout });
      const stderrReader = createInterface({ input: child.stderr });
      stdoutReader.on("line", (line) => onLine(line, "stdout"));
      stderrReader.on("line", (line) => onLine(line, "stderr"));

      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.once("exit", (code, signal) => {
        if (provisioningUrl) {
          return;
        }
        clearTimeout(timer);
        const detail =
          stderrLines.join("\n") ||
          (signal
            ? `signal-cli link terminated by ${signal}`
            : `signal-cli link exited with code ${String(code)}`);
        reject(new Error(detail));
      });
    });

    const linkUrl = await waitForProvisioningUrl;
    if (this.aborted) {
      return;
    }

    const qrDataUrl = await qrCode.toDataURL(linkUrl, {
      width: 256,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
    this.qrDataUrl = qrDataUrl;
    this.lastError = null;
    this.setStatus("waiting_for_qr");
    this.options.onEvent({
      type: "signal-qr",
      accountId: this.options.accountId,
      qrDataUrl,
    });

    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (this.aborted) {
          resolve();
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const detail =
          stderrLines.join("\n") ||
          (signal
            ? `signal-cli link terminated by ${signal}`
            : `signal-cli link exited with code ${String(code)}`);
        reject(new Error(detail));
      });
    });

    if (this.aborted) {
      return;
    }

    const phoneNumber = await this.readLinkedSignalAccount(cliPath);
    this.finishConnected(phoneNumber, undefined);
  }

  private finishConnected(phoneNumber: string | null, uuid?: string): void {
    this.activeChild = null;
    this.qrDataUrl = null;
    this.phoneNumber = phoneNumber;
    this.lastError = null;
    this.setStatus("connected");
    this.options.onEvent({
      type: "signal-status",
      accountId: this.options.accountId,
      status: "connected",
      ...(uuid ? { uuid } : {}),
      phoneNumber: this.phoneNumber ?? undefined,
    });

    console.info(
      `${LOG_PREFIX} Device linked successfully${phoneNumber ? ` (${phoneNumber})` : ""}`,
    );
  }

  private async readLinkedSignalAccount(
    cliPath: string,
  ): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        cliPath,
        ["--config", this.options.authDir, "-o", "json", "listAccounts"],
        {
          env: buildSignalCliEnv(),
        },
      );
      return parseSignalCliAccountsOutput(stdout);
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Failed to read linked Signal account: ${String(error)}`,
      );
      return null;
    }
  }
}

export function signalAuthExists(
  workspaceDir: string,
  accountId = "default",
): boolean {
  const authDir = path.join(workspaceDir, "signal-auth", accountId);
  if (!fs.existsSync(authDir)) {
    return false;
  }

  const accountsPath = path.join(authDir, "data", "accounts.json");
  if (!fs.existsSync(accountsPath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(accountsPath, "utf8")) as {
      accounts?: unknown;
    };
    return Array.isArray(parsed.accounts) && parsed.accounts.length > 0;
  } catch {
    return false;
  }
}

export function signalLogout(
  workspaceDir: string,
  accountId = "default",
): void {
  const authDir = path.join(workspaceDir, "signal-auth", accountId);
  fs.rmSync(authDir, { recursive: true, force: true });
}
