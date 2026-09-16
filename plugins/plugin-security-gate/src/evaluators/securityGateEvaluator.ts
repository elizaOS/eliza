import type {
  ActionResult,
  Evaluator,
  EvaluatorProcessorContext,
  EvaluatorPromptContext,
  EvaluatorRunContext,
  JsonValue,
  Memory,
} from "@elizaos/core";
import {
  inspectPayloadLocally,
  type LocalAuditResult,
} from "../localSecurityGate.js";

declare const process: { env?: Record<string, string | undefined> } | undefined;

export interface SecurityGateEvaluationResult {
  verdict: "ALLOW" | "WARN" | "BLOCK";
  risk_score: number;
  threats: string[];
  mode: "local" | "remote-oracle";
}

export const securityGateEvaluator: Evaluator<LocalAuditResult> = {
  name: "SECURITY_GATE_EVALUATOR",
  similes: [
    "PROMPT_INJECTION_RADAR",
    "AST_HAZARD_GUARD",
    "HALLUCINATION_VERIFIER",
  ],
  description:
    "Evaluates messages for prompt injections, AST hazards, and adversarial breakouts with local-first verification.",

  schema: {
    type: "object",
    properties: {
      verdict: { type: "string" },
      risk_score: { type: "number" },
      threats: {
        type: "array",
        items: { type: "string" },
      },
      executionTimeMs: { type: "number" },
    },
    required: ["verdict", "risk_score", "threats"],
  },

  async shouldRun(context: EvaluatorRunContext): Promise<boolean> {
    const text = context.message?.content?.text || "";
    return Boolean(text && text.trim().length > 0);
  },

  resolveOutputWhen: () => true,

  resolveOutput(context: EvaluatorPromptContext): LocalAuditResult {
    const text = context.message?.content?.text || "";
    return inspectPayloadLocally(text);
  },

  prompt(context: EvaluatorPromptContext): string {
    const text = context.message?.content?.text || "";
    return `Evaluate safety for the following message:\n${text}`;
  },

  processors: [
    {
      name: "securityGateIncidentRecorder",
      async process(
        context: EvaluatorProcessorContext<LocalAuditResult>,
      ): Promise<ActionResult | undefined> {
        const audit = context.output;
        let finalVerdict: "ALLOW" | "WARN" | "BLOCK" = audit.verdict;
        let finalRisk = audit.risk_score;
        const finalThreats = [...audit.threats];

        // Opt-in remote oracle if user configured SECURITY_GATE_URL
        const env = process?.env ?? {};
        const configuredGateUrl =
          context.runtime.getSetting("SECURITY_GATE_URL") ||
          env.SECURITY_GATE_URL;

        if (configuredGateUrl && finalVerdict !== "BLOCK") {
          try {
            const response = await fetch(
              `${configuredGateUrl}/api/v1/inspect`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(env.SECURITY_GATE_API_KEY
                    ? { "X-API-Key": env.SECURITY_GATE_API_KEY }
                    : {}),
                },
                body: JSON.stringify({
                  agent_output: context.message.content?.text || "",
                  is_code: false,
                  raise_on_block: false,
                }),
                signal: AbortSignal.timeout(3000),
              },
            );

            if (response.ok) {
              const result = (await response.json()) as {
                audit?: {
                  verdict?: "ALLOW" | "WARN" | "BLOCK";
                  risk_score?: number;
                  threats?: string[];
                };
              };
              if (result.audit?.verdict === "BLOCK") {
                finalVerdict = "BLOCK";
                finalRisk = Math.max(finalRisk, result.audit.risk_score || 0);
                finalThreats.push(...(result.audit.threats || []));
              }
            }
          } catch (err) {
            console.warn(
              "[SecurityGateEvaluator] Remote oracle check failed, maintaining local verdict:",
              err,
            );
          }
        }

        // If blocked, record security violation memory for audit & incident containment
        if (finalVerdict === "BLOCK" && context.runtime.createMemory) {
          const incidentMemory: Memory = {
            id: context.message.id,
            entityId: context.message.entityId,
            agentId: context.runtime.agentId,
            roomId: context.message.roomId,
            content: {
              text: `🚨 [SECURITY GATE BLOCKED] Threats: ${finalThreats.join(", ")} (Risk: ${finalRisk}%)`,
              source: "security-gate",
              isBlocked: true,
              riskScore: finalRisk,
            },
          };
          await context.runtime.createMemory(incidentMemory, "messages");
        }

        return {
          success: finalVerdict !== "BLOCK",
          text: `Security evaluation completed: ${finalVerdict} (Risk: ${finalRisk}%)`,
          data: {
            audit: {
              verdict: finalVerdict,
              risk_score: finalRisk,
              threats: finalThreats,
            } as unknown as Record<string, JsonValue>,
          },
        };
      },
    },
  ],
};
