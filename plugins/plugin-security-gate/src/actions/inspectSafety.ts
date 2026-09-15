declare const process: { env?: Record<string, string | undefined> } | undefined;

export const inspectSafetyAction = {
  name: "INSPECT_SAFETY",
  similes: ["AUDIT_OUTPUT", "CHECK_SECURITY", "SCAN_PROMPT", "VERIFY_PAYLOAD"],
  description:
    "Explicitly inspects an agent output, text payload, or Python code snippet against prompt injection and AST vulnerabilities using Security Gate x402.",

  async validate(_runtime: any, message: any): Promise<boolean> {
    const text = message?.content?.text || "";
    return Boolean(text && text.trim().length > 0);
  },

  async handler(
    runtime: any,
    message: any,
    _state: any,
    _options: any,
    callback?: (response: any) => Promise<any>
  ): Promise<boolean> {
    const env = typeof process !== "undefined" && process?.env ? process.env : {};
    const gateUrl =
      runtime.getSetting("SECURITY_GATE_URL") ||
      env.SECURITY_GATE_URL ||
      "https://agent-security-gate-x402-212942243360.asia-northeast3.run.app";

    const payloadText = message.content.text;

    try {
      const resp = await fetch(`${gateUrl}/api/v1/inspect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.AGENT_VAULT_KEY ? { "X-Vault-Key": env.AGENT_VAULT_KEY } : {}),
        },
        body: JSON.stringify({
          agent_output: payloadText,
          is_code: false,
          raise_on_block: false,
        }),
      });

      if (!resp.ok) {
        if (callback) {
          await callback({
            text: `⚠️ Security Gate inspection failed (HTTP ${resp.status}).`,
          });
        }
        return false;
      }

      const data: any = await resp.json();
      const audit = data.audit || {};
      const verdict = audit.verdict || "ALLOW";
      const risk = audit.risk_score || 0;

      const replyText =
        verdict === "BLOCK"
          ? `🚨 [SECURITY GATE: BLOCKED] Risk Score: ${risk}%\nThreats detected: ${audit.threats?.join(", ")}`
          : `✅ [SECURITY GATE: PASSED] Risk Score: ${risk}% | Verified Safe by The Sheriff.`;

      if (callback) {
        await callback({
          text: replyText,
          data: data,
        });
      }

      return verdict !== "BLOCK";
    } catch (err: any) {
      if (callback) {
        await callback({
          text: `⚠️ Error contacting Security Gate micro-oracle: ${err.message}`,
        });
      }
      return false;
    }
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
          text: "✅ [SECURITY GATE: PASSED] Risk Score: 0% | Verified Safe by The Sheriff.",
          action: "INSPECT_SAFETY",
        },
      },
    ],
  ],
};
