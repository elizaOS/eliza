/**
 * @elizaos-plugins/plugin-sigui
 *
 * Sigui DePIN AI Security Oracle — ElizaOS Plugin
 *
 * Intercepts transaction calls from ElizaOS agents and evaluates them
 * in real-time using the Sigui Protocol API v2:
 *   - Vision inference (Qwen2-VL-7B on AMD MI300X GPU)
 *   - ZK-Sigui proofs (Groth16 BN128 simulation)
 *   - Dynamic threat blacklist (feedback loop)
 *
 * @module @elizaos-plugins/plugin-sigui
 * @version 3.0.0
 * @license MIT
 */

import type { Plugin, IAgentRuntime, Memory, State, Action, Provider, ActionExample, HandlerCallback } from "@elizaos/core";

// ─── Environment ────────────────────────────────────────────────────────────

export interface SiguiConfig {
  SIGUI_API_URL: string;
  SIGUI_API_KEY?: string;
  SIGUI_REQUIRE_ZK?: boolean;
  SIGUI_FAIL_CLOSED?: boolean;
}

export async function validateSiguiConfig(runtime: IAgentRuntime): Promise<SiguiConfig> {
  const url = runtime.getSetting("SIGUI_API_URL") || process.env.SIGUI_API_URL || "http://127.0.0.1:8000";
  const key = runtime.getSetting("SIGUI_API_KEY") || process.env.SIGUI_API_KEY;
  const requireZk = (runtime.getSetting("SIGUI_REQUIRE_ZK") || process.env.SIGUI_REQUIRE_ZK || "false") === "true";
  const failClosed = (runtime.getSetting("SIGUI_FAIL_CLOSED") || process.env.SIGUI_FAIL_CLOSED || "true") === "true";
  return { SIGUI_API_URL: url, SIGUI_API_KEY: key, SIGUI_REQUIRE_ZK: requireZk, SIGUI_FAIL_CLOSED: failClosed };
}

// ─── Action: EVALUATE_TRANSACTION_SECURITY ───────────────────────────────────

const EVALUATION_TEMPLATE = `
Extract information about the blockchain transaction from the user's message.

User Message:
{{message.content.text}}

Extract:
- action_type: The type of action ('transfer', 'swap', 'approve', 'mint', 'interact'). Default: 'transfer'.
- destination: The destination address or contract. Default: "0x0000000000000000000000000000000000000000".
- amount: Numerical amount involved. Default: 0.
- chain: Blockchain network ('ethereum', 'aptos', 'starknet', 'solana', 'polygon', 'arc'). Default: 'ethereum'.
`;

async function callSiguiApi(config: SiguiConfig, payload: object): Promise<any> {
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

  if (!response.ok) {
    throw new Error(`Sigui API returned ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

export const evaluateTransactionAction: Action = {
  name: "EVALUATE_TRANSACTION_SECURITY",
  similes: ["CHECK_TRANSACTION_SAFETY", "AUDIT_TRANSACTION", "VERIFY_SMART_CONTRACT", "IS_THIS_SAFE", "SIGUI_CHECK"],
  description:
    "Evaluates a blockchain transaction or address using the Sigui Protocol AI Security Oracle (AMD MI300X + ZK proofs) to detect Drain Stars, Mixer Chains, and Rug Pulls before execution.",

  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    await validateSiguiConfig(runtime);
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const config = await validateSiguiConfig(runtime);

    // Naive extraction — in production compose with LLM
    const text = (message.content as any)?.text || "";
    const addressMatch = text.match(/0x[a-fA-F0-9]{40}/);
    const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:USDC|ETH|BTC|SOL|APT)/i);

    const payload = {
      action_type: "transfer",
      destination: addressMatch ? addressMatch[0] : "0x0000000000000000000000000000000000000000",
      amount_usdc: amountMatch ? parseFloat(amountMatch[1]) : 0,
      chain: "ethereum",
    };

    try {
      const result = await callSiguiApi(config, payload);

      const decision: string = result.decision || "BLOCK";
      const riskScore: number = result.risk_score || 1.0;
      const reason: string = result.reason || "Threat detected by Sigui AI Oracle";
      const pattern: string = result.pattern || "UNKNOWN";
      const zkProof: boolean = !!result.zk_proof?.verified;

      const zkBadge = zkProof ? " [ZK-Verified ✓]" : "";

      let responseText: string;
      if (decision === "BLOCK") {
        responseText = `🚨 **SIGUI SECURITY ALERT — BLOCKED**${zkBadge}\n\nPattern: **${pattern}** | Risk: **${(riskScore * 100).toFixed(0)}%**\n\n${reason}\n\nThis transaction has been blocked by Sigui AI Oracle.`;
      } else if (decision === "ESCALATE") {
        responseText = `⚠️ **SIGUI WARNING — ESCALATION REQUIRED**${zkBadge}\n\nPattern: **${pattern}** | Risk: **${(riskScore * 100).toFixed(0)}%**\n\nAwaiting human review before proceeding.`;
      } else {
        responseText = `✅ **SIGUI CLEARED**${zkBadge}\n\nPattern: **${pattern}** | Risk: **${(riskScore * 100).toFixed(0)}%**\n\nTransaction to ${payload.destination.slice(0, 10)}… is safe to execute.`;
      }

      if (callback) callback({ text: responseText, content: result });

      if (decision === "BLOCK" && config.SIGUI_FAIL_CLOSED) {
        return false;
      }
      return true;
    } catch (error: any) {
      if (callback) {
        callback({
          text: `❌ Sigui Oracle unreachable: ${error.message}. ${config.SIGUI_FAIL_CLOSED ? "Failing closed for safety." : "Proceeding with caution."}`,
          content: { error: error.message },
        });
      }
      return !config.SIGUI_FAIL_CLOSED;
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "Send 500 USDC to 0x1234567890123456789012345678901234567890" },
      },
      {
        user: "{{agent}}",
        content: {
          text: "Let me verify this address with the Sigui AI Oracle before sending.",
          action: "EVALUATE_TRANSACTION_SECURITY",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: { text: "Is 0x000000000000000000000000000000000000dead a safe contract?" },
      },
      {
        user: "{{agent}}",
        content: {
          text: "Running a Sigui deep scan to detect honeypots or Drain Stars...",
          action: "EVALUATE_TRANSACTION_SECURITY",
        },
      },
    ],
  ] as ActionExample[][],
};

// ─── Provider: Threat Intel ──────────────────────────────────────────────────

export const threatIntelProvider: Provider = {
  get: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<string> => {
    try {
      const config = await validateSiguiConfig(runtime);
      const resp = await fetch(`${config.SIGUI_API_URL}/api/threat-intel`, {
        headers: config.SIGUI_API_KEY ? { Authorization: `Bearer ${config.SIGUI_API_KEY}` } : {},
      });
      if (!resp.ok) return "Sigui threat intel unavailable.";
      const data = await resp.json();
      const patterns = (data.patterns || []).slice(0, 5);
      if (patterns.length === 0) return "No active threats detected by Sigui.";
      const lines = patterns.map(
        (p: any) => `• ${p.destination?.slice(0, 12)}… — ${p.pattern} (conf: ${(p.confidence * 100).toFixed(0)}%)`
      );
      return `**Sigui Live Threat Intel (last ${patterns.length} learned):**\n${lines.join("\n")}`;
    } catch {
      return "Sigui threat intel unavailable (oracle offline).";
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
