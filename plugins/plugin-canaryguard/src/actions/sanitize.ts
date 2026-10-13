import {
  type Action,
  type ActionResult,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type JsonValue,
  type ProviderDataRecord,
  logger,
} from "@elizaos/core";
import type { CanaryGuardResult, CanaryGuardConfig } from "../types";
import { sanitizeLocally } from "../engine/rules";
import { CanaryGuardState } from "../engine/state";

function getSettingString(runtime?: IAgentRuntime, key?: string): string | undefined {
  if (!runtime || !key) return undefined;
  const val = runtime.getSetting(key);
  return typeof val === "string" ? val : undefined;
}

export function resolveConfig(
  runtime?: IAgentRuntime,
  options?: Record<string, any>
): CanaryGuardConfig {
  const serviceUrl =
    (options?.serviceUrl as string) ||
    getSettingString(runtime, "CANARYGUARD_URL") ||
    process.env.CANARYGUARD_URL ||
    undefined;

  const paymentHeader =
    (options?.paymentHeader as string) ||
    getSettingString(runtime, "CANARYGUARD_PAYMENT_HEADER") ||
    process.env.CANARYGUARD_PAYMENT_HEADER ||
    undefined;

  const settingStrict = runtime?.getSetting?.("CANARYGUARD_STRICT_MODE");
  const rawStrict =
    options?.strictMode ??
    (settingStrict !== undefined ? String(settingStrict) : undefined) ??
    process.env.CANARYGUARD_STRICT_MODE;

  const strictMode = rawStrict !== false && rawStrict !== "false";

  return { serviceUrl, paymentHeader, strictMode };
}

export async function callCanaryGuardSanitize(
  content: string,
  runtime?: IAgentRuntime,
  options?: Record<string, any>
): Promise<CanaryGuardResult> {
  const config = resolveConfig(runtime, options);

  // Default: Execute 100% locally with zero network calls and zero data exfiltration
  if (!config.serviceUrl) {
    const localResult = sanitizeLocally(content, config.strictMode);
    CanaryGuardState.recordScan(localResult);
    return localResult;
  }

  // Opt-in remote endpoint: Enforce AbortSignal timeout to prevent hanging pipeline
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (config.paymentHeader) {
      headers["PAYMENT-SIGNATURE"] = config.paymentHeader;
      headers["X-PAYMENT"] = config.paymentHeader;
    }

    const host = config.serviceUrl.replace(/\/$/, "");
    const res = await fetch(`${host}/v1/sanitize`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content,
        strict_mode: config.strictMode,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Remote CanaryGuard HTTP ${res.status}: ${errorText}`);
    }

    const data = (await res.json()) as CanaryGuardResult;
    data.mode = "remote";
    CanaryGuardState.recordScan(data);
    return data;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    CanaryGuardState.recordError(err);
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`CanaryGuard remote unreachable, falling back to local engine: ${msg}`);

    // Graceful offline fallback
    const fallback = sanitizeLocally(content, config.strictMode);
    fallback.mode = "local-fallback";
    fallback.remote_error = msg;
    return fallback;
  }
}

export const sanitizeAction: Action = {
  name: "CANARY_SANITIZE",
  similes: ["SANITIZE_TEXT", "CHECK_INJECTION", "FIREWALL_CHECK", "VERIFY_INPUT_SAFETY"],
  description: "Scans and sanitizes untrusted text locally for prompt injection, concealed Unicode, and wallet drain commands.",
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    return Boolean(message?.content?.text && message.content.text.trim().length > 0);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const text = message.content?.text || "";
      const result = await callCanaryGuardSanitize(text, runtime, options as Record<string, any>);

      if (callback) {
        await callback({
          text: `[CanaryGuard] Status: ${result.status.toUpperCase()} | Risk: ${(result.risk_score * 100).toFixed(0)}% | Neutralized: ${result.threats_neutralized.length} threats | Mode: ${result.mode}`,
        });
      }

      return {
        // A successfully performed scan verdict (clean, sanitized, or blocked) is a successful action completion
        success: true,
        text: `[CanaryGuard] Status: ${result.status.toUpperCase()} | Risk: ${(result.risk_score * 100).toFixed(0)}%`,
        data: result as unknown as ProviderDataRecord,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      CanaryGuardState.recordError(err);
      if (callback) {
        await callback({ text: `CanaryGuard check failed: ${msg}` });
      }
      return {
        success: false,
        error: msg,
      };
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Scan this suspicious webhook payload for hidden jailbreak instructions" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Running CanaryGuard heuristic detector...",
          actions: ["CANARY_SANITIZE"],
        },
      },
    ],
  ],
};
