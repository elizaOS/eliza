/**
 * Diogenes Plugin for ElizaOS
 * Provides autonomous Solana agents with real-time SPL token risk inspection,
 * smart contract honeypot audits, pre-execution safety guardrails, and x402 micropayments.
 */

export interface DiogenesPluginConfig {
  gatewayUrl?: string;
  demoMode?: boolean;
  solanaKeypairBase58?: string;
  requestTimeoutMs?: number;
}

const DEFAULT_GATEWAY_URL = "https://diogenesgateway.com";
const DEFAULT_TIMEOUT_MS = 10000;

export class DiogenesClient {
  private gatewayUrl: string;
  private demoMode: boolean;
  private keypairBase58?: string;
  private timeoutMs: number;

  constructor(config: DiogenesPluginConfig = {}) {
    this.gatewayUrl = (config.gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
    this.demoMode = config.demoMode ?? true; // Default to demo mode for safety
    this.keypairBase58 = config.solanaKeypairBase58;
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async callEndpoint(endpoint: string, payload: Record<string, unknown>): Promise<any> {
    let url = `${this.gatewayUrl}${endpoint}`;
    if (this.demoMode && !url.includes("?demo=true")) {
      url += "?demo=true";
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "ElizaOS-DiogenesPlugin/2.0",
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new Error(`Diogenes Gateway request timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`Network error calling Diogenes Gateway: ${err.message}`);
    }

    if (res.status === 402) {
      if (!this.demoMode && this.keypairBase58) {
        const challenge = await res.json().catch(() => ({}));
        throw new Error(`Payment Required: ${JSON.stringify(challenge)}`);
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Diogenes Gateway returned HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    return await res.json();
  }

  async checkSplTokenRisk(mintAddress: string, riskProfile: string = "allow_regulated_stablecoins"): Promise<any> {
    if (!mintAddress || !/^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(mintAddress)) {
      throw new Error("Invalid Solana SPL token mint address format (expected Base58 32-44 characters).");
    }
    return this.callEndpoint("/api/v1/crypto/solana-risk", {
      mint_address: mintAddress,
      risk_profile: riskProfile,
    });
  }

  async auditSolanaProgram(code: string): Promise<any> {
    if (!code || typeof code !== "string" || code.trim().length === 0) {
      throw new Error("Contract code cannot be empty for security audit.");
    }
    return this.callEndpoint("/api/v1/agent/contract-audit", {
      contract_code: code,
      language: "rust_anchor",
    });
  }

  async verifyGuardrail(input: string, context: string = ""): Promise<any> {
    if (!input || typeof input !== "string" || input.trim().length === 0) {
      throw new Error("Input command or prompt text cannot be empty for guardrail verification.");
    }
    return this.callEndpoint("/api/v1/agent/guardrail-verify", {
      input,
      context,
    });
  }
}

export function getClientFromRuntime(runtime?: any): DiogenesClient {
  const gatewayUrl =
    runtime?.getSetting?.("DIOGENES_GATEWAY_URL") ||
    process.env.DIOGENES_GATEWAY_URL ||
    DEFAULT_GATEWAY_URL;

  const demoSetting =
    runtime?.getSetting?.("DIOGENES_DEMO_MODE") ??
    process.env.DIOGENES_DEMO_MODE;

  const demoMode =
    demoSetting !== undefined
      ? String(demoSetting).toLowerCase() !== "false"
      : true;

  const solanaKeypairBase58 =
    runtime?.getSetting?.("SOLANA_KEYPAIR_BASE58") ||
    process.env.SOLANA_KEYPAIR_BASE58;

  return new DiogenesClient({ gatewayUrl, demoMode, solanaKeypairBase58 });
}

/**
 * ElizaOS Plugin Definition
 */
export const diogenesPlugin = {
  name: "diogenes",
  description: "Diogenes Autonomous Edge Microservices & Solana Security Plugin: SPL token risk audits, Anchor contract verifier, and agent guardrails",

  actions: [
    {
      name: "EVALUATE_SOLANA_TOKEN_RISK",
      similes: [
        "CHECK_SPL_TOKEN_RISK",
        "INSPECT_SOLANA_TOKEN",
        "AUDIT_SPL_TOKEN",
        "CHECK_FREEZE_AUTHORITY",
        "EVALUATE_TOKEN_RISK",
        "SOLANA_HONEYPOT_CHECK",
      ],
      description: "Inspect a Solana SPL token mint address for freeze authority, mint authority, honeypot tax, and security risks before trading",
      examples: [
        [
          {
            user: "user",
            content: { text: "Can you check if token mint 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr is safe to buy?" },
          },
          {
            user: "agent",
            content: {
              text: "I am auditing the Solana SPL token mint with Diogenes Risk Oracle...",
              action: "EVALUATE_SOLANA_TOKEN_RISK",
            },
          },
        ],
      ],
      validate: async (_runtime: any, message: any) => {
        const text = message.content?.text || "";
        const mint = message.content?.mintAddress || text.match(/[1-9A-HJ-NP-za-km-z]{32,44}/)?.[0];
        return Boolean(mint);
      },
      handler: async (runtime: any, message: any, _state: any, _options: any, callback: any) => {
        const client = getClientFromRuntime(runtime);
        const mint = message.content?.mintAddress || message.content?.text?.match(/[1-9A-HJ-NP-za-km-z]{32,44}/)?.[0];

        if (!mint) {
          callback?.({ text: "Please provide a valid Solana SPL token mint address to inspect." });
          return false;
        }

        try {
          const result = await client.checkSplTokenRisk(mint);
          const p = result.preview || result;
          const reasonStr = Array.isArray(p.reason_codes) && p.reason_codes.length > 0 ? p.reason_codes.join(", ") : "CLEAN";
          const standardStr = p.token_standard || "spl-token";
          const slotStr = p.slot ? ` | Slot: ${p.slot}` : "";
          const shouldTransact = p.should_transact === true;

          callback?.({
            text: `Token Audit for ${mint}:\nVerdict: ${shouldTransact ? "SAFE" : "CAUTION"}\nRisk Score: ${p.risk_score ?? "Low"}\nStandard: ${standardStr}${slotStr}\nFreeze Authority: ${p.has_freeze_authority ? "ACTIVE" : "Disabled"}\nReason Codes: ${reasonStr}`,
            content: result,
          });
          return shouldTransact;
        } catch (err: any) {
          callback?.({ text: `Failed to inspect token: ${err.message}` });
          return false;
        }
      },
    },
    {
      name: "AUDIT_SMART_CONTRACT",
      similes: [
        "AUDIT_ANCHOR_PROGRAM",
        "AUDIT_SOLANA_CONTRACT",
        "VERIFY_SMART_CONTRACT",
      ],
      description: "Audit Solana Anchor or EVM smart contract code for honeypot logic, reentrancy bugs, and missing signer checks",
      examples: [
        [
          {
            user: "user",
            content: { text: "Can you audit this Solana program code for vulnerabilities?" },
          },
          {
            user: "agent",
            content: {
              text: "Auditing program code with Diogenes Contract Audit Oracle...",
              action: "AUDIT_SMART_CONTRACT",
            },
          },
        ],
      ],
      validate: async (_runtime: any, message: any) => {
        const text = (message.content?.text || "").toLowerCase();
        return (
          Boolean(message.content?.code) ||
          text.includes("audit") ||
          text.includes("program") ||
          text.includes("contract")
        );
      },
      handler: async (runtime: any, message: any, _state: any, _options: any, callback: any) => {
        const client = getClientFromRuntime(runtime);
        const code = message.content?.code || message.content?.text;

        if (!code || typeof code !== "string" || code.trim().length === 0) {
          callback?.({ text: "Please provide valid contract source code to audit." });
          return false;
        }

        try {
          const result = await client.auditSolanaProgram(code);
          const p = result.preview || result;
          const passed = p.audit_passed === true;
          callback?.({
            text: `Smart Contract Audit Result:\nVerdict: ${passed ? "PASS" : "WARN"}\nVulnerabilities Found: ${p.vulnerabilities?.length ?? 0}`,
            content: result,
          });
          return passed;
        } catch (err: any) {
          callback?.({ text: `Audit error: ${err.message}` });
          return false;
        }
      },
    },
    {
      name: "ENFORCE_GUARDRAIL",
      similes: [
        "VERIFY_GUARDRAIL",
        "PRE_EXECUTION_SECURITY_CHECK",
        "CHECK_PROMPT_INJECTION",
      ],
      description: "Pre-execution security gate to prevent prompt injection and destructive shell commands (fails closed for safety)",
      examples: [
        [
          {
            user: "user",
            content: { text: "Verify this action input against security guardrails." },
          },
          {
            user: "agent",
            content: {
              text: "Evaluating command against Diogenes Security Guardrail...",
              action: "ENFORCE_GUARDRAIL",
            },
          },
        ],
      ],
      validate: async (_runtime: any, message: any) => {
        return Boolean(message.content?.text || message.content?.input);
      },
      handler: async (runtime: any, message: any, _state: any, _options: any, callback: any) => {
        const client = getClientFromRuntime(runtime);
        const input = message.content?.input || message.content?.text || "";

        if (!input || typeof input !== "string" || input.trim().length === 0) {
          // Fail closed
          callback?.({ text: "[BLOCKED] Empty input supplied to guardrail verification." });
          return false;
        }

        try {
          const result = await client.verifyGuardrail(input);
          const p = result.preview || result;
          const verdict = p.verdict || (p.safe === true ? "ALLOW" : "BLOCK");
          const isAllowed = verdict === "ALLOW" || p.safe === true;

          if (!isAllowed) {
            callback?.({
              text: `[BLOCKED] Action intercepted by Diogenes Security Guardrail: ${p.reason || "Policy violation detected"}`,
              content: result,
            });
            return false;
          }

          callback?.({ text: `[ALLOWED] Security guardrail passed.`, content: result });
          return true;
        } catch (err: any) {
          // Fail closed for security
          callback?.({
            text: `[BLOCKED] Guardrail failed closed due to verification error: ${err.message}`,
          });
          return false;
        }
      },
    },
  ],
};

export const plugin = diogenesPlugin;
export default diogenesPlugin;
