import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OAuthCredentials } from "./types.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal ANSI color sequences from CLI output.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const DEVICE_URL_RE = /https:\/\/auth\.openai\.com\/codex\/device/;
const DEVICE_CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;

export interface CodexDeviceFlow {
  authUrl: string;
  userCode: string;
  credentials: Promise<OAuthCredentials>;
  close: () => void;
}

function expiryFromJwt(token: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: unknown };
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    // Fall through to a conservative one-hour lifetime.
  }
  return Date.now() + 60 * 60 * 1000;
}

export function startCodexDeviceLogin(): Promise<CodexDeviceFlow> {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "eliza-codex-device-"));
  const child = spawn("codex", ["login", "--device-auth"], {
    env: { ...process.env, CODEX_HOME: codexHome, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let settledStart = false;
  let resolveCredentials!: (credentials: OAuthCredentials) => void;
  let rejectCredentials!: (error: Error) => void;
  const credentials = new Promise<OAuthCredentials>((resolve, reject) => {
    resolveCredentials = resolve;
    rejectCredentials = reject;
  });
  void credentials.catch(() => undefined);

  return new Promise<CodexDeviceFlow>((resolve, reject) => {
    const inspect = (chunk: Buffer | string) => {
      output += String(chunk).replace(ANSI_RE, "");
      if (settledStart) return;
      const url = output.match(DEVICE_URL_RE)?.[0];
      const userCode = output.match(DEVICE_CODE_RE)?.[0];
      if (!url || !userCode) return;
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
    child.once("error", (err) => {
      if (!settledStart) reject(err);
      rejectCredentials(err);
      rmSync(codexHome, { recursive: true, force: true });
    });
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        const err = new Error(
          `Codex device login exited ${signal ? `with ${signal}` : `with code ${code}`}`,
        );
        if (!settledStart) reject(err);
        rejectCredentials(err);
        rmSync(codexHome, { recursive: true, force: true });
        return;
      }
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
        resolveCredentials({
          access,
          refresh,
          expires: expiryFromJwt(access),
          ...(parsed.tokens?.id_token
            ? { idToken: parsed.tokens.id_token }
            : {}),
        });
      } catch (err) {
        rejectCredentials(err instanceof Error ? err : new Error(String(err)));
      } finally {
        rmSync(codexHome, { recursive: true, force: true });
      }
    });
  });
}
