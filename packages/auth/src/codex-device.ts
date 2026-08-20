/**
 * Orchestrates headless Codex device login for authentication consumers.
 *
 * The flow owns an isolated temporary CODEX_HOME, parses only the public
 * device prompt, and withholds credentials until the child is terminal and
 * that temporary state has been removed successfully.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import type { OAuthCredentials } from "./types.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal ANSI color sequences from CLI output.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const DEVICE_URL_RE = /https:\/\/auth\.openai\.com\/codex\/device/;
const DEVICE_CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;
const CLEANUP_MAX_RETRIES = 2;
const CLEANUP_RETRY_DELAY_MS = 25;

type CodexDeviceErrorCode =
  | "codex_device.cleanup_failed"
  | "codex_device.credentials_invalid"
  | "codex_device.invalid_access_token"
  | "codex_device.process_failed"
  | "codex_device.prompt_missing"
  | "codex_device.spawn_failed";

type CleanupPhase =
  | "credentials_complete"
  | "credentials_invalid"
  | "process_failed"
  | "prompt_missing"
  | "spawn_failed";

function codexDeviceError(
  code: CodexDeviceErrorCode,
  message: string,
  options: {
    cause?: unknown;
    context?: Record<string, unknown>;
    severity: "ephemeral" | "fatal";
  },
): ElizaError {
  return new ElizaError(message, {
    code,
    severity: options.severity,
    ...(options.context ? { context: options.context } : {}),
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
  });
}

export interface CodexDeviceFlow {
  authUrl: string;
  userCode: string;
  credentials: Promise<OAuthCredentials>;
  close: () => void;
}

export function codexDeviceLoginUsesShell(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32";
}

function expiryFromJwt(token: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      throw new Error("Codex access token has no finite exp claim");
    }
    return payload.exp * 1000;
  } catch (cause) {
    // error-policy:J2 context-adding rethrow — fabricating an expiry can make an
    // invalid token look healthy and delay required reauthentication.
    throw codexDeviceError(
      "codex_device.invalid_access_token",
      "Codex access token expiry could not be validated",
      { cause, severity: "fatal" },
    );
  }
}

export function startCodexDeviceLogin(): Promise<CodexDeviceFlow> {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "eliza-codex-device-"));
  const child = spawn("codex", ["login", "--device-auth"], {
    env: { ...process.env, CODEX_HOME: codexHome, NO_COLOR: "1" },
    // npm installs Codex as a `.cmd` shim on Windows. The command and its
    // arguments are static, so the shell is used only to make that shim
    // executable; Unix keeps the direct child process and signal behavior.
    shell: codexDeviceLoginUsesShell(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let spawned = false;
  let settledStart = false;
  let settledTerminal = false;
  let cleanedUp = false;
  let resolveCredentials!: (credentials: OAuthCredentials) => void;
  let rejectCredentials!: (error: Error) => void;
  const credentials = new Promise<OAuthCredentials>((resolve, reject) => {
    resolveCredentials = resolve;
    rejectCredentials = reject;
  });
  // error-policy:J5 the returned flow exposes this promise to its caller; this
  // observer prevents a process-level rejection before the flow is consumed.
  void credentials.catch(() => undefined);

  const cleanup = (phase: CleanupPhase): ElizaError | null => {
    if (cleanedUp) return null;
    try {
      rmSync(codexHome, {
        recursive: true,
        force: true,
        maxRetries: CLEANUP_MAX_RETRIES,
        retryDelay: CLEANUP_RETRY_DELAY_MS,
      });
      cleanedUp = true;
      return null;
    } catch (cause) {
      // error-policy:J1 filesystem boundary translation — cleanup is part of
      // terminal settlement, so its failure becomes a typed promise rejection
      // instead of escaping a child-process event callback.
      return codexDeviceError(
        "codex_device.cleanup_failed",
        "Codex device login temporary state could not be removed",
        {
          cause,
          context: {
            phase,
            maxRetries: CLEANUP_MAX_RETRIES,
            retryDelayMs: CLEANUP_RETRY_DELAY_MS,
          },
          severity: "fatal",
        },
      );
    }
  };

  return new Promise<CodexDeviceFlow>((resolve, reject) => {
    const rejectStart = (error: Error) => {
      if (settledStart) return;
      settledStart = true;
      reject(error);
    };
    const fail = (error: ElizaError, phase: CleanupPhase) => {
      const terminalError = cleanup(phase) ?? error;
      rejectStart(terminalError);
      rejectCredentials(terminalError);
    };
    const inspect = (chunk: Buffer | string) => {
      if (settledStart) return;
      output += String(chunk).replace(ANSI_RE, "");
      const url = output.match(DEVICE_URL_RE)?.[0];
      const userCode = output.match(DEVICE_CODE_RE)?.[0];
      if (!url || !userCode) return;
      output = "";
      settledStart = true;
      resolve({
        authUrl: url,
        userCode,
        credentials,
        close: () => child.kill("SIGTERM"),
      });
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("spawn", () => {
      spawned = true;
    });
    child.on("error", (err) => {
      if (settledTerminal) return;
      if (spawned) {
        // error-policy:J6 a running child can emit `error` when SIGTERM delivery
        // fails. It is still live, so retain CODEX_HOME and wait for `close`
        // instead of misclassifying teardown as a failed spawn.
        logger.debug(
          "[auth] Codex device login termination signal failed; waiting for process close",
        );
        return;
      }
      settledTerminal = true;
      fail(
        codexDeviceError(
          "codex_device.spawn_failed",
          "Codex device login process could not be started",
          {
            cause: err,
            context: { command: "codex", mode: "device-auth" },
            severity: "fatal",
          },
        ),
        "spawn_failed",
      );
    });
    // `close` follows the exit event after stdio has closed, so the prompt
    // parser has observed every output chunk before deciding it was absent.
    child.once("close", (code, signal) => {
      if (settledTerminal) return;
      settledTerminal = true;
      if (code !== 0) {
        const err = codexDeviceError(
          "codex_device.process_failed",
          `Codex device login exited ${signal ? `with ${signal}` : `with code ${code}`}`,
          {
            context: { exitCode: code, signal },
            severity: "ephemeral",
          },
        );
        fail(err, "process_failed");
        return;
      }
      if (!settledStart) {
        fail(
          codexDeviceError(
            "codex_device.prompt_missing",
            "Codex device login exited with code 0 before emitting a device URL and user code",
            {
              context: { exitCode: code, signal },
              severity: "fatal",
            },
          ),
          "prompt_missing",
        );
        return;
      }
      let parsedCredentials: OAuthCredentials;
      try {
        const parsed = JSON.parse(
          readFileSync(path.join(codexHome, "auth.json"), "utf8"),
        ) as {
          tokens?: {
            access_token?: string;
            refresh_token?: string;
            id_token?: string;
          };
        };
        const access = parsed.tokens?.access_token;
        const refresh = parsed.tokens?.refresh_token;
        if (!access || !refresh)
          throw new Error("Codex device login returned no tokens");
        parsedCredentials = {
          access,
          refresh,
          expires: expiryFromJwt(access),
          ...(parsed.tokens?.id_token
            ? { idToken: parsed.tokens.id_token }
            : {}),
        };
      } catch (cause) {
        // error-policy:J2 context-adding translation — credential-file and JWT
        // failures become a typed terminal flow error with their cause intact.
        fail(
          cause instanceof ElizaError
            ? cause
            : codexDeviceError(
                "codex_device.credentials_invalid",
                "Codex device login credentials could not be validated",
                { cause, severity: "fatal" },
              ),
          "credentials_invalid",
        );
        return;
      }

      const cleanupError = cleanup("credentials_complete");
      if (cleanupError) {
        rejectCredentials(cleanupError);
        return;
      }
      resolveCredentials(parsedCredentials);
    });
  });
}
