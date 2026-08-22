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
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  tokens?: unknown;
}

function parseCodexCliAuthJson(raw: string): CodexCliAuthJson | null {
  try {
    const data: unknown = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as CodexCliAuthJson)
      : null;
  } catch {
    // error-policy:J3 the CLI-owned file is untrusted input; null is an
    // explicit invalid-file signal, distinct from an absent credential file.
    return null;
  }
}

type CodexCliSubscriptionState = "absent" | "invalid" | "valid";

/**
 * Classify the Codex CLI credential file without collapsing a present broken
 * login into the same state as an absent or direct-API-only configuration.
 */
function codexCliSubscriptionState(): CodexCliSubscriptionState {
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  let raw: string;
  try {
    raw = fs.readFileSync(authPath, "utf-8");
  } catch (cause) {
    // error-policy:J4 an absent optional CLI credential contributes no row;
    // other read failures mean the configured surface is present but invalid.
    return (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "invalid";
  }

  const data = parseCodexCliAuthJson(raw);
  if (!data) return "invalid";

  if (data.tokens !== undefined) {
    if (
      !data.tokens ||
      typeof data.tokens !== "object" ||
      Array.isArray(data.tokens)
    ) {
      return "invalid";
    }
    const accessToken = (data.tokens as Record<string, unknown>).access_token;
    return typeof accessToken === "string" && accessToken.trim()
      ? "valid"
      : "invalid";
  }

  const authMode =
    typeof data.auth_mode === "string" ? data.auth_mode.trim() : "";
  if (authMode.toLowerCase() === "api-key") return "absent";
  if (data.OPENAI_API_KEY !== undefined || data.auth_mode !== undefined) {
    return typeof data.OPENAI_API_KEY === "string" &&
      data.OPENAI_API_KEY.trim() &&
      authMode
      ? "valid"
      : "invalid";
  }
  return "invalid";
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
    // error-policy:J4 optional binary discovery returns false when PATH lookup
    // cannot execute or find the command.
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
    detectExternalCredentials: (): DiscoveredSubscriptionCredential | null => {
      const state = codexCliSubscriptionState();
      return state === "absent"
        ? null
        : {
            accountId: "codex-cli",
            label: "Codex CLI",
            source: "codex-cli",
            configured: true,
            valid: state === "valid",
            expiresAt: null,
          };
    },
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
