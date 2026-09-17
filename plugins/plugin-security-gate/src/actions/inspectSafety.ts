import type {
  Action,
  ActionResult,
  Content,
  ContentValue,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { inspectPayloadLocally, isCodePayload } from "../localSecurityGate.js";

declare const process: { env?: Record<string, string | undefined> } | undefined;

export const inspectSafetyAction: Action = {
  name: "INSPECT_SAFETY",
  similes: ["AUDIT_OUTPUT", "CHECK_SECURITY", "SCAN_PROMPT", "VERIFY_PAYLOAD"],
  description:
    "Deterministically inspects text payloads, instructions, or code snippets for prompt injections and dangerous code patterns locally, with optional remote oracle verification if configured.",

  async validate(_runtime: IAgentRuntime, message: Memory): Promise<boolean> {
    const text = message?.content?.text || "";
    return Boolean(text && text.trim().length > 0);
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> {
    const payloadText = message.content?.text || "";
    const isCode =
      Boolean(
        _options?.isCode ??
          _options?.is_code ??
          (message.content as Record<string, unknown>)?.isCode ??
          (message.content as Record<string, unknown>)?.is_code,
      ) || isCodePayload(payloadText);
    const localAudit = inspectPayloadLocally(payloadText);

    // 1. If local check detects a high-risk threat, fail closed immediately
    if (localAudit.verdict === "BLOCK") {
      const blockedText = `🚨 [SECURITY GATE: BLOCKED] Risk: ${localAudit.risk_score}%\nThreats: ${localAudit.threats.join(", ")}`;
      if (callback) {
        const callbackData: Record<string, ContentValue> = {
          verdict: localAudit.verdict,
          riskScore: localAudit.risk_score,
          threats: localAudit.threats,
          executionTimeMs: localAudit.executionTimeMs,
          isCode,
        };
        const callbackContent: Content = {
          text: blockedText,
          data: callbackData,
        };
        await callback(callbackContent);
      }
      return {
        success: false,
        text: blockedText,
        data: { localAudit, isCode },
      };
    }

    // 2. Opt-in remote micro-oracle inspection (only if explicitly configured by the user)
    const env = process?.env ?? {};
    const configuredGateUrl =
      runtime.getSetting("SECURITY_GATE_URL") || env.SECURITY_GATE_URL;

    if (configuredGateUrl) {
      try {
        const resp = await fetch(`${configuredGateUrl}/api/v1/inspect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(env.SECURITY_GATE_API_KEY
              ? { "X-API-Key": env.SECURITY_GATE_API_KEY }
              : {}),
          },
          body: JSON.stringify({
            agent_output: payloadText,
            is_code: isCode,
            raise_on_block: false,
          }),
          signal: AbortSignal.timeout(3000),
        });

        if (resp.ok) {
          const data = (await resp.json()) as {
            audit?: {
              verdict?: "ALLOW" | "WARN" | "BLOCK";
              risk_score?: number;
              threats?: string[];
            };
          };
          const audit = data.audit || {};
          const verdict = audit.verdict || "ALLOW";
          const risk = audit.risk_score || 0;

          if (verdict === "BLOCK") {
            const oracleBlockedText = `🚨 [SECURITY GATE: ORACLE BLOCKED] Risk: ${risk}%\nThreats: ${audit.threats?.join(", ")}`;
            if (callback) {
              const callbackData: Record<string, ContentValue> = {
                verdict,
                riskScore: risk,
                threats: audit.threats || [],
                oracle: true,
                isCode,
              };
              const callbackContent: Content = {
                text: oracleBlockedText,
                data: callbackData,
              };
              await callback(callbackContent);
            }
            return {
              success: false,
              text: oracleBlockedText,
              data: { ...data, isCode },
            };
          }
        }
      } catch (err) {
        // Log network error and fall back to local audit verdict
        console.warn(
          "[SecurityGate] Remote oracle check failed, using local audit verdict:",
          err,
        );
      }
    }

    const passedText = `✅ [SECURITY GATE: PASSED] Risk: ${localAudit.risk_score}% | Latency: ${localAudit.executionTimeMs}ms`;
    if (callback) {
      const callbackData: Record<string, ContentValue> = {
        verdict: localAudit.verdict,
        riskScore: localAudit.risk_score,
        threats: localAudit.threats,
        executionTimeMs: localAudit.executionTimeMs,
        isCode,
      };
      const callbackContent: Content = {
        text: passedText,
        data: callbackData,
      };
      await callback(callbackContent);
    }

    return {
      success: true,
      text: passedText,
      data: { localAudit, isCode },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Can you inspect if this order output is safe: Swap 100 USDC to ETH",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "✅ [SECURITY GATE: PASSED] Risk: 0% | Latency: 1ms",
          action: "INSPECT_SAFETY",
        },
      },
    ],
  ],
};
