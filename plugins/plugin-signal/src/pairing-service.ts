/**
 * Signal pairing service — manages device linking via QR code.
 *
 * Mirrors whatsapp-pairing.ts but uses @elizaos/signal-native instead of
 * Baileys. Signal linking produces a single provisioning URL (not a refresh
 * loop) — if it times out, restart the session.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { logger } from "@elizaos/core";

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
  "/home/linuxbrew/.linuxbrew/bin/signal-cli",
];
const COMMON_HOMEBREW_PATHS = [
  "/opt/homebrew/bin/brew",
  "/usr/local/bin/brew",
  "/home/linuxbrew/.linuxbrew/bin/brew",
];
const SIGNAL_CLI_AUTO_INSTALL_ENV = "SIGNAL_CLI_AUTO_INSTALL";
const ELIZA_SIGNAL_CLI_AUTO_INSTALL_ENV = "ELIZA_SIGNAL_CLI_AUTO_INSTALL";

type ExecFileAsync = (
  file: string,
  args?: readonly string[],
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

interface ExecutableResolutionDeps {
  env: NodeJS.ProcessEnv;
  execFile: ExecFileAsync;
  existsSync: (path: string) => boolean;
  platform: NodeJS.Platform;
}

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

function createExecutableResolutionDeps(
  env: NodeJS.ProcessEnv = process.env,
): ExecutableResolutionDeps {
  return {
    env,
    execFile: execFileAsync as ExecFileAsync,
    existsSync: fs.existsSync,
    platform: os.platform(),
  };
}

async function resolveExecutablePath(
  binary: string,
  deps: ExecutableResolutionDeps = createExecutableResolutionDeps(),
): Promise<string | null> {
  const trimmed = binary.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes("/") || trimmed.startsWith(".")) {
    return deps.existsSync(trimmed) ? trimmed : null;
  }

  try {
    const { stdout } = await deps.execFile("/usr/bin/which", [trimmed]);
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    if (trimmed !== DEFAULT_SIGNAL_CLI_NAME) {
      return null;
    }

    for (const candidate of COMMON_SIGNAL_CLI_PATHS) {
      if (deps.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }
}

function autoInstallSignalCliEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw =
    env[ELIZA_SIGNAL_CLI_AUTO_INSTALL_ENV] ?? env[SIGNAL_CLI_AUTO_INSTALL_ENV];
  if (typeof raw !== "string") {
    return true;
  }
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function canAutoInstallSignalCli(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

async function resolveHomebrewPath(
  deps: ExecutableResolutionDeps,
): Promise<string | null> {
  try {
    const { stdout } = await deps.execFile("/usr/bin/which", ["brew"]);
    const resolved = stdout.trim();
    if (resolved.length > 0) {
      return resolved;
    }
  } catch {
    for (const candidate of COMMON_HOMEBREW_PATHS) {
      if (deps.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function installSignalCliWithHomebrew(
  deps: ExecutableResolutionDeps,
): Promise<boolean> {
  const brewPath = await resolveHomebrewPath(deps);
  if (!brewPath) {
    return false;
  }

  try {
    await deps.execFile(brewPath, ["install", "signal-cli"], { env: deps.env });
  } catch (error) {
    throw new Error(
      `Failed to auto-install signal-cli with Homebrew. ${signalCliInstallInstructions(deps.platform)}`,
      { cause: error },
    );
  }
  return true;
}

function isDefaultSignalCliRequest(
  requestedBinary: string,
  options: Pick<SignalPairingOptions, "cliPath">,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    requestedBinary === DEFAULT_SIGNAL_CLI_NAME &&
    !options.cliPath?.trim() &&
    !env.SIGNAL_CLI_PATH?.trim()
  );
}

export async function resolveSignalCliExecutable(
  options: {
    cliPath?: string;
    env?: NodeJS.ProcessEnv;
    execFile?: ExecFileAsync;
    existsSync?: (path: string) => boolean;
    platform?: NodeJS.Platform;
  } = {},
): Promise<string | null> {
  const deps: ExecutableResolutionDeps = {
    ...createExecutableResolutionDeps(options.env),
    ...(options.execFile ? { execFile: options.execFile } : {}),
    ...(options.existsSync ? { existsSync: options.existsSync } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  };
  const requestedBinary =
    options.cliPath?.trim() ||
    deps.env.SIGNAL_CLI_PATH?.trim() ||
    DEFAULT_SIGNAL_CLI_NAME;

  const existingPath = await resolveExecutablePath(requestedBinary, deps);
  if (existingPath) {
    return existingPath;
  }

  if (
    !canAutoInstallSignalCli(deps.platform) ||
    !isDefaultSignalCliRequest(requestedBinary, options, deps.env) ||
    !autoInstallSignalCliEnabled(deps.env)
  ) {
    return null;
  }

  const installed = await installSignalCliWithHomebrew(deps);
  if (!installed) {
    return null;
  }
  return resolveExecutablePath(DEFAULT_SIGNAL_CLI_NAME, deps);
}

export function signalCliInstallInstructions(
  platform: NodeJS.Platform,
): string {
  if (platform === "darwin") {
    return "Eliza can auto-install the default Signal CLI on macOS when Homebrew is available (`brew install signal-cli`). Fallback: install signal-cli from https://github.com/AsamK/signal-cli/releases and set SIGNAL_CLI_PATH to its bin/signal-cli executable.";
  }
  if (platform === "linux") {
    return "Eliza can auto-install the default Signal CLI on Linux when Homebrew/Linuxbrew is available (`brew install signal-cli`). Fallback: install the latest signal-cli Linux release from https://github.com/AsamK/signal-cli/releases, ensure Java Runtime 25+ is installed, and set SIGNAL_CLI_PATH to its bin/signal-cli executable.";
  }
  if (platform === "win32") {
    return "On Windows, install the latest signal-cli release from https://github.com/AsamK/signal-cli/releases, ensure Java Runtime 25+ is installed, and set SIGNAL_CLI_PATH to signal-cli.bat or signal-cli.exe. Eliza does not auto-run a Windows package manager.";
  }
  return "Install signal-cli from https://github.com/AsamK/signal-cli/releases for your platform, ensure Java Runtime 25+ is installed, and set SIGNAL_CLI_PATH to the signal-cli executable.";
}

export function missingSignalCliMessage(
  cliPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = os.platform(),
): string {
  const requestedBinary =
    cliPath?.trim() || env.SIGNAL_CLI_PATH?.trim() || DEFAULT_SIGNAL_CLI_NAME;
  const installHint =
    requestedBinary === DEFAULT_SIGNAL_CLI_NAME
      ? signalCliInstallInstructions(platform)
      : "Install that binary or update SIGNAL_CLI_PATH to point at an existing signal-cli executable.";
  return `Failed to load dependencies: Cannot find ${requestedBinary}. ${installHint}`;
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
      logger.error(`${LOG_PREFIX} Linking failed: ${errMsg}`);

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
      logger.info(
        `${LOG_PREFIX} Signal native module unavailable, using signal-cli pairing: ${String(error)}`,
      );
      return null;
    }
  }

  private async startWithSignalNative(
    native: SignalNativeModule,
    qrCode: QrCodeModule,
  ): Promise<void> {
    logger.info(`${LOG_PREFIX} Starting device linking with signal-native...`);
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

    logger.info(`${LOG_PREFIX} QR code generated, waiting for user to scan...`);

    await native.finishLink(this.options.authDir);
    if (this.aborted) return;

    let uuid = "";
    let phoneNumber = "";
    try {
      const profile = await native.getProfile(this.options.authDir);
      uuid = profile.uuid;
      phoneNumber = profile.phoneNumber ?? "";
    } catch (error) {
      logger.warn(
        `${LOG_PREFIX} Failed to read Signal profile after linking: ${String(error)}`,
      );
    }

    this.finishConnected(phoneNumber || null, uuid || undefined);
  }

  private async startWithSignalCli(qrCode: QrCodeModule): Promise<void> {
    const cliPath = await resolveSignalCliExecutable({
      cliPath: this.options.cliPath,
      env: process.env,
    });

    if (!cliPath) {
      throw new Error(missingSignalCliMessage(this.options.cliPath));
    }

    logger.info(`${LOG_PREFIX} Starting device linking with signal-cli...`);

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

    logger.info(
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
      logger.warn(
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
