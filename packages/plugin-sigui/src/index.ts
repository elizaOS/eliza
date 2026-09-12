/**
 * @elizaos/plugin-sigui
 *
 * Sigui DePIN AI Security Oracle — ElizaOS Plugin v2
 *
 * @module @elizaos/plugin-sigui
 * @version 3.1.0
 * @license MIT
 */

import type {
  Plugin,
  IAgentRuntime,
  Memory,
  State,
  Action,
  Provider,
  ActionExample,
  HandlerCallback,
  ProviderResult,
  ProviderExecutionContext,
} from "@elizaos/core";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface SiguiConfig {
  SIGUI_API_URL: string;
  SIGUI_API_KEY?: string;
  SIGUI_REQUIRE_ZK?: boolean;
  SIGUI_FAIL_CLOSED?: boolean;
}

export async function validateSiguiConfig(runtime: IAgentRuntime): Promise<SiguiConfig> {
  const url = runtime.getSetting("SIGUI_API_URL") || process.env.SIGUI_API_URL;
  const key = runtime.getSetting("SIGUI_API_KEY") || process.env.SIGUI_API_KEY;
  const requireZk = (runtime.getSetting("SIGUI_REQUIRE_ZK") || process.env.SIGUI_REQUIRE_ZK || "false") === "true";
  const failClosed = (runtime.getSetting("SIGUI_FAIL_CLOSED") || process.env.SIGUI_FAIL_CLOSED || "true") === "true";
  return { SIGUI_API_URL: url ?? "http://127.0.0.1:8000", SIGUI_API_KEY: key, SIGUI_REQUIRE_ZK: requireZk, SIGUI_FAIL_CLOSED: failClosed };
}

// ─── API helper ───────────────────────────────────────────────────────────────

async function callSiguiApi(config: SiguiConfig, payload: object): Promise<Record<string, unknown>> {
  const zkParam = config.SIGUI_REQUIRE_ZK ? "?zk=true" : "";
  const endpoint = `${config.SIGUI_API_URL}/v2/evaluate${zkParam}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.SIGUI_API_KEY && { Authorization: `Bearer ${config.SIGUI_API_KEY}` }),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Sigui API returned ${response.status}: ${response.statusText}`);
  return response.json() as Promise<Record<string, unknown>>;
}

// ─── Action: EVALUATE_TRANSACTION_SECURITY ───────────────────────────────────

export const evaluateTransactionAction: Action = {
  name: "EVALUATE_TRANSACTION_SECURITY",
  similes: ["CHECK_TRANSACTION_SAFETY", "AUDIT_TRANSACTION", "VERIFY_SMART_CONTRACT", "IS_THIS_SAFE", "SIGUI_CHECK"],
  description:
    "Evaluates a blockchain transaction or address using the Sigui Protocol AI Security Oracle (AMD MI300X + ZK proofs) to detect Drain Stars, Mixer Chains, and Rug Pulls before execution.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const url = runtime.getSetting("SIGUI_API_URL") || process.env.SIGUI_API_URL;
    // Only route when explicitly configured — avoids posting to loopback on unconfigured agents
    return !!url;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<void> => {
    const config = await validateSiguiConfig(runtime);

    const text = (message.content as Record<string, unknown>)?.text as string ?? "";
    const addressMatch = text.match(/0x[a-fA-F0-9]{40}/);
    const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:USDC|ETH|BTC|SOL|APT)/i);

    const payload = {
      action_type: "transfer",
      destination: addressMatch?.[0] ?? "0x0000000000000000000000000000000000000000",
      amount_usdc: amountMatch ? parseFloat(amountMatch[1]) : 0,
      chain: "ethereum",
    };

    try {
      const result = await callSiguiApi(config, payload);
      const decision = (result.decision as string) ?? "BLOCK";
      const riskScore = (result.risk_score as number) ?? 1.0;
      const reason = (result.reason as string) ?? "Threat detected by Sigui AI Oracle";
      const pattern = (result.pattern as string) ?? "UNKNOWN";
      const zkVerified = !!(result.zk_proof as Record<string, unknown>)?.verified;
      const zkBadge = zkVerified ? " [ZK-Verified ✓]" : "";

      let responseText: string;
      if (decision === "BLOCK") {
        responseText = `🚨 **SIGUI SECURITY ADVISORY — BLOCK**${zkBadge}\n\nPattern: **${pattern}** | Risk: **${(riskScore * 100).toFixed(0)}%**\n\n${reason}\n\n⚠️ Human review required before executing this transaction.`;
      } else if (decision === "ESCALATE") {
        responseText = `⚠️ **SIGUI WARNING — ESCALATION REQUIRED**${zkBadge}\n\nPattern: **${pattern}** | Risk: **${(riskScore * 100).toFixed(0)}%**\n\nAwaiting human review before proceeding.`;
      } else {
        responseText = `✅ **SIGUI CLEARED**${zkBadge}\n\nPattern: **${pattern}** | Risk: **${(riskScore * 100).toFixed(0)}%**\n\nNo known threat topology detected for ${payload.destination.slice(0, 10)}….`;
      }

      if (callback) await callback({ text: responseText, content: result as Record<string, unknown> });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "unknown error";
      if (callback) {
        await callback({
          text: `❌ Sigui Oracle unreachable: ${msg}. ${config.SIGUI_FAIL_CLOSED ? "Halting for safety — human review required." : "Proceeding with caution."}`,
          content: { error: msg },
        });
      }
    }
  },

  examples: [
    [
      { user: "{{user1}}", content: { text: "Send 500 USDC to 0x1234567890123456789012345678901234567890" } },
      { user: "{{agent}}", content: { text: "Let me verify this address with the Sigui AI Oracle before sending.", action: "EVALUATE_TRANSACTION_SECURITY" } },
    ],
    [
      { user: "{{user1}}", content: { text: "Is 0x000000000000000000000000000000000000dead a safe contract?" } },
      { user: "{{agent}}", content: { text: "Running a Sigui deep scan to detect honeypots or Drain Stars...", action: "EVALUATE_TRANSACTION_SECURITY" } },
    ],
  ] as ActionExample[][],
};

// ─── Provider: Threat Intel ──────────────────────────────────────────────────

export const threatIntelProvider: Provider = {
  name: "SIGUI_THREAT_INTEL",
  description: "Injects live Sigui threat intelligence — recently learned malicious patterns and flagged addresses — into the agent's context.",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _context?: ProviderExecutionContext
  ): Promise<ProviderResult> => {
    try {
      const config = await validateSiguiConfig(runtime);
      const resp = await fetch(`${config.SIGUI_API_URL}/api/threat-intel`, {
        headers: config.SIGUI_API_KEY ? { Authorization: `Bearer ${config.SIGUI_API_KEY}` } : {},
      });
      if (!resp.ok) return { text: "Sigui threat intel unavailable." };
      const data = await resp.json() as Record<string, unknown>;
      const patterns = ((data.patterns as unknown[]) ?? []).slice(0, 5);
      if (patterns.length === 0) return { text: "No active threats detected by Sigui." };
      const lines = (patterns as Record<string, unknown>[]).map(
        (p) => `• ${(p.destination as string)?.slice(0, 12)}… — ${p.pattern} (conf: ${((p.confidence as number) * 100).toFixed(0)}%)`
      );
      return { text: `**Sigui Live Threat Intel (last ${patterns.length} learned):**\n${lines.join("\n")}` };
    } catch {
      return { text: "Sigui threat intel unavailable (oracle offline)." };
    }
  },
};

// ─── Plugin Export ───────────────────────────────────────────────────────────

export const siguiPlugin: Plugin = {
  name: "sigui",
  description:
    "Sigui Protocol — DePIN AI Security Oracle for ElizaOS. Detects Drain Stars, Mixer Chains & Rug Pulls using Qwen2-VL-7B on AMD MI300X + Groth16 ZK proofs.",
  actions: [evaluateTransactionAction],
  evaluators: [],
  providers: [threatIntelProvider],
};

export default siguiPlugin;
