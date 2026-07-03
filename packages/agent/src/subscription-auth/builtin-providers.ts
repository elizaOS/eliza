/**
 * Built-in {@link SubscriptionAuthProvider} descriptors.
 *
 * Vendor-specific credential *discovery* (the surfaces where a login can be
 * found: a first-party CLI login blob, a tool on `PATH`, an unavailable
 * provider) lives here rather than inside host `auth/`, and is drained
 * generically by `auth/credentials.ts` through the `@elizaos/core`
 * subscription-auth registry.
 *
 * These are host built-ins today. The registry API is public, so the
 * model-provider plugin that owns a vendor can register (and thereby own) its
 * own descriptor via `registerSubscriptionAuthProvider` — replacing the
 * built-in without any change to host `auth/`.
 *
 * @module subscription-auth/builtin-providers
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type DiscoveredSubscriptionCredential,
  hasSubscriptionAuthProvider,
  registerSubscriptionAuthProvider,
} from "@elizaos/core";

// ── openai-codex: ~/.codex/auth.json (Codex CLI ChatGPT login) ───────────────

/** Shape of `~/.codex/auth.json` (Codex CLI); fields vary by CLI version. */
interface CodexCliAuthJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
  };
}

function parseCodexCliAuthJson(raw: string): CodexCliAuthJson | null {
  try {
    const data = JSON.parse(raw) as CodexCliAuthJson;
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * True when `~/.codex/auth.json` holds a usable Codex CLI subscription login
 * (a ChatGPT OAuth token, or an API key paired with a non-`api-key` auth mode).
 */
function hasCodexCliSubscriptionAuth(): boolean {
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  try {
    const data = parseCodexCliAuthJson(fs.readFileSync(authPath, "utf-8"));
    if (!data) return false;
    if (data.tokens?.access_token?.trim()) return true;
    return Boolean(
      data.OPENAI_API_KEY?.trim() &&
        data.auth_mode?.trim() &&
        data.auth_mode.trim().toLowerCase() !== "api-key",
    );
  } catch {
    return false;
  }
}

// ── gemini-cli: `gemini` binary on PATH ──────────────────────────────────────

function hasCommandOnPath(commandName: string): boolean {
  const command = process.platform === "win32" ? "where" : "command -v";
  try {
    execSync(`${command} ${commandName}`, {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Register the built-in subscription-auth descriptors if they are not already
 * present. Idempotent (keyed on the registry, so it re-seeds after a test
 * reset), so it is safe to call from every host entry point that drains the
 * registry.
 */
export function ensureBuiltinSubscriptionAuthProviders(): void {
  // Any built-in present ⇒ already seeded. `openai-codex` is the sentinel.
  if (hasSubscriptionAuthProvider("openai-codex")) return;

  registerSubscriptionAuthProvider({
    id: "openai-codex",
    detectExternalCredentials: (): DiscoveredSubscriptionCredential | null =>
      hasCodexCliSubscriptionAuth()
        ? {
            accountId: "codex-cli",
            label: "Codex CLI",
            source: "codex-cli",
            configured: true,
            valid: true,
            expiresAt: null,
          }
        : null,
  });

  registerSubscriptionAuthProvider({
    id: "gemini-cli",
    detectExternalCredentials: (): DiscoveredSubscriptionCredential => {
      const detected = hasCommandOnPath("gemini");
      return {
        accountId: "gemini-cli",
        label: "Gemini CLI",
        source: detected ? "gemini-cli" : null,
        configured: detected,
        valid: detected,
        expiresAt: null,
      };
    },
  });

  registerSubscriptionAuthProvider({
    id: "deepseek-coding",
    detectExternalCredentials: (): DiscoveredSubscriptionCredential => ({
      accountId: "deepseek-coding",
      label: "DeepSeek Coding Plan",
      source: "unavailable",
      configured: false,
      valid: false,
      expiresAt: null,
    }),
  });
}
