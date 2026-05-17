import { type IAgentRuntime, logger } from "@elizaos/core";
import { getApiKeyOptional, getAuthMode, isBrowser } from "./utils/config";
import { getClaudeOAuthMeta, getClaudeOAuthToken } from "./utils/credential-store";

export interface PluginConfig {
  readonly ANTHROPIC_API_KEY?: string;
  readonly ANTHROPIC_SMALL_MODEL?: string;
  readonly ANTHROPIC_LARGE_MODEL?: string;
  readonly ANTHROPIC_EXPERIMENTAL_TELEMETRY?: string;
  readonly ANTHROPIC_BASE_URL?: string;
  readonly ANTHROPIC_BROWSER_BASE_URL?: string;
  readonly ANTHROPIC_COT_BUDGET?: string;
  readonly ANTHROPIC_COT_BUDGET_SMALL?: string;
  readonly ANTHROPIC_COT_BUDGET_LARGE?: string;
  readonly ANTHROPIC_AUTH_MODE?: string;
  readonly ANTHROPIC_REASONING_SMALL_MODEL?: string;
  readonly ANTHROPIC_REASONING_LARGE_MODEL?: string;
}

const _globalThis = globalThis as typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: boolean;
};
if (_globalThis.AI_SDK_LOG_WARNINGS === undefined) {
  _globalThis.AI_SDK_LOG_WARNINGS = false;
}

export function initializeAnthropic(_config: PluginConfig, runtime: IAgentRuntime): void {
  void (async () => {
    const authMode = getAuthMode(runtime);

    if (authMode === "cli") {
      try {
        const bunRuntime = (
          globalThis as typeof globalThis & {
            Bun?: {
              spawnSync(
                args: string[],
                options: { stdout: "pipe"; stderr: "pipe" }
              ): { exitCode: number };
            };
          }
        ).Bun;
        const result = bunRuntime?.spawnSync(["claude", "--version"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        if (!result || result.exitCode !== 0) throw new Error("claude not found");
        logger.log("[Anthropic] CLI mode — using `claude -p` for all model calls");
      } catch {
        logger.warn(
          "[Anthropic] CLI mode enabled but `claude` command not found. Install Claude Code: https://code.claude.com"
        );
      }
      return;
    }

    if (authMode === "oauth") {
      try {
        const token = getClaudeOAuthToken();
        const meta = getClaudeOAuthMeta();
        if (meta) {
          logger.log(
            `[Anthropic] OAuth configured — subscription: ${meta.subscriptionType}, ` +
              `tier: ${meta.rateLimitTier}, expires: ${new Date(token.expiresAt).toISOString()}`
          );
        } else {
          logger.log("[Anthropic] OAuth configured via CLAUDE_CODE_OAUTH_TOKEN env var");
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[Anthropic] OAuth credential issue: ${message} — ` +
            "Ensure Claude Code is authenticated (run `claude auth login`) or set CLAUDE_CODE_OAUTH_TOKEN."
        );
      }
      return;
    }

    const apiKey = getApiKeyOptional(runtime);

    if (!apiKey && !isBrowser()) {
      logger.warn(
        "ANTHROPIC_API_KEY is not set in environment - Anthropic functionality will be limited. " +
          "Set ANTHROPIC_API_KEY in your environment variables or runtime settings."
      );
      return;
    }

    if (apiKey) {
      logger.log("Anthropic API key configured successfully");
    }
  })();
}
