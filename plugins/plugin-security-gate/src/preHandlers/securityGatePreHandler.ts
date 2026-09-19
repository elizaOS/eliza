import type {
  ChatPreHandler,
  ChatPreHandlerContext,
  ChatPreHandlerResult,
} from "@elizaos/core";
import { inspectPayloadLocally, isCodePayload } from "../localSecurityGate.js";

declare const process: { env?: Record<string, string | undefined> } | undefined;

/**
 * Composes the caller's cancellation signal (if any) with an independent timeout signal.
 * Ensures the operation aborts if either the caller cancels or the timeout expires.
 */
export function composeBoundedSignal(
  callerSignal?: AbortSignal,
  timeoutMs = 3000,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) {
    return timeoutSignal;
  }
  if (callerSignal.aborted) {
    return callerSignal;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal.reason);
  const onTimeout = () => controller.abort(timeoutSignal.reason);
  callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  timeoutSignal.addEventListener("abort", onTimeout, { once: true });
  return controller.signal;
}

/**
 * Inbound fail-closed security pre-handler.
 * Drained before the chat generation loop, response models, and action processing.
 * Returns a terminal responseText to short-circuit upon attack detection, or null to pass through.
 */
export const securityGatePreHandler: ChatPreHandler = {
  id: "security-gate-inbound",
  priority: 1000,

  async tryHandle(
    ctx: ChatPreHandlerContext,
  ): Promise<ChatPreHandlerResult | null> {
    const text = ctx.message.content?.text || "";
    if (!text.trim()) {
      return null;
    }

    // 1. Local deterministic inspection (<1ms, zero network)
    const localAudit = inspectPayloadLocally(text);
    if (localAudit.verdict === "BLOCK") {
      return {
        responseText: `🚨 [SECURITY GATE: BLOCKED] Inbound prompt injection / hazard detected: ${localAudit.threats.join(", ")} (Risk: ${localAudit.risk_score}%)`,
      };
    }

    // 2. Opt-in remote micro-oracle inspection (if explicitly configured)
    const env = process?.env ?? {};
    const configuredGateUrl =
      ctx.runtime.getSetting("SECURITY_GATE_URL") || env.SECURITY_GATE_URL;

    if (configuredGateUrl) {
      try {
        const isCode = isCodePayload(text);
        const resp = await fetch(`${configuredGateUrl}/api/v1/inspect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(env.SECURITY_GATE_API_KEY
              ? { "X-API-Key": env.SECURITY_GATE_API_KEY }
              : {}),
          },
          body: JSON.stringify({
            agent_output: text,
            is_code: isCode,
            raise_on_block: false,
          }),
          signal: composeBoundedSignal(ctx.abortSignal, 3000),
        });

        if (resp.ok) {
          const data = (await resp.json()) as {
            audit?: {
              verdict?: "ALLOW" | "WARN" | "BLOCK";
              risk_score?: number;
              threats?: string[];
            };
          };
          if (data.audit?.verdict === "BLOCK") {
            const risk = data.audit.risk_score || 0;
            const threats = data.audit.threats?.join(", ") || "Unknown threat";
            return {
              responseText: `🚨 [SECURITY GATE: ORACLE BLOCKED] Inbound hazard detected: ${threats} (Risk: ${risk}%)`,
            };
          }
        }
      } catch (err) {
        // Fall back safely to local audit verdict
        console.warn(
          "[SecurityGatePreHandler] Remote oracle check failed, using local audit verdict:",
          err,
        );
      }
    }

    return null;
  },
};
