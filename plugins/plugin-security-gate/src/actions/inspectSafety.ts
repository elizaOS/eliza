import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { inspectPayloadLocally } from "../localSecurityGate";

declare const process: { env?: Record<string, string | undefined> } | undefined;

export const inspectSafetyAction: Action = {
  name: "INSPECT_SAFETY",
  similes: ["AUDIT_OUTPUT", "CHECK_SECURITY", "SCAN_PROMPT", "VERIFY_PAYLOAD"],
  description:
    "Deterministically inspects text payloads, instructions, or code snippets for prompt injections and AST hazards locally, with optional remote oracle verification if configured.",

  async validate(_runtime: IAgentRuntime, message: Memory): Promise<boolean> {
    const text = message?.content?.text || "";
    return Boolean(text && text.trim().length > 0);
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> {
    const payloadText = message.content?.text || "";
    const localAudit = inspectPayloadLocally(payloadText);

    // 1. If local check detects a high-risk threat, fail closed immediately (zero network required)
    if (localAudit.verdict === "BLOCK") {
      if (callback) {
        await callback({
          text: `🚨 [SECURITY GATE: BLOCKED] Risk: ${localAudit.risk_score}%\nThreats detected: ${localAudit.threats.join(", ")}`,
          data: { localAudit },
        });
      }
      return false;
    }

    // 2. Opt-in remote micro-oracle inspection (only if explicitly configured by the user)
    const env = typeof process !== "undefined" && process?.env ? process.env : {};
    const configuredGateUrl = runtime.getSetting("SECURITY_GATE_URL") || env.SECURITY_GATE_URL;

    if (configuredGateUrl) {
      try {
        const resp = await fetch(`${configuredGateUrl}/api/v1/inspect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(env.SECURITY_GATE_API_KEY ? { "X-API-Key": env.SECURITY_GATE_API_KEY } : {}),
          },
          body: JSON.stringify({
            agent_output: payloadText,
            is_code: false,
            raise_on_block: false,
          }),
          signal: AbortSignal.timeout(3000),
        });

        if (resp.ok) {
          const data = (await resp.json()) as {
            audit?: { verdict?: "ALLOW" | "WARN" | "BLOCK"; risk_score?: number; threats?: string[] };
          };
          const audit = data.audit || {};
          const verdict = audit.verdict || "ALLOW";
          const risk = audit.risk_score || 0;

          if (verdict === "BLOCK") {
            if (callback) {
              await callback({
                text: `🚨 [SECURITY GATE: ORACLE BLOCKED] Risk: ${risk}%\nThreats: ${audit.threats?.join(", ")}`,
                data,
              });
            }
            return false;
          }
        }
      } catch (err) {
        // Log network error and fall back to local audit verdict
        console.warn("[SecurityGate] Remote oracle check failed, using local audit verdict:", err);
      }
    }

    if (callback) {
      await callback({
        text: `✅ [SECURITY GATE: PASSED] Risk: ${localAudit.risk_score}% | Latency: ${localAudit.executionTimeMs}ms`,
        data: { localAudit },
      });
    }

    return true;
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "Can you inspect if this order output is safe: Swap 100 USDC to ETH" },
      },
      {
        user: "{{agentName}}",
        content: {
          text: "✅ [SECURITY GATE: PASSED] Risk: 0% | Latency: 1ms",
          action: "INSPECT_SAFETY",
        },
      },
    ],
  ],
};
