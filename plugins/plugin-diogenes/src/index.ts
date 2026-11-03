/**
 * Diogenes Plugin for ElizaOS
 * Provides autonomous Solana agents with real-time SPL token risk inspection,
 * smart contract honeypot audits, pre-execution safety guardrails, and x402 micropayments.
 */

export interface DiogenesPluginConfig {
  gatewayUrl?: string;
  demoMode?: boolean;
  solanaKeypairBase58?: string;
}

const DEFAULT_GATEWAY_URL = "https://diogenesgateway.com";
const SOLANA_X402_WALLET = "3vuU9jvaohMG6oPY7NVrUggcSJ4CuhcByxoQk68EC6hj";

export class DiogenesClient {
  private gatewayUrl: string;
  private demoMode: boolean;
  private keypairBase58?: string;

  constructor(config: DiogenesPluginConfig = {}) {
    this.gatewayUrl = (config.gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/$/, "");
    this.demoMode = config.demoMode ?? true; // Default to demo mode for safety
    this.keypairBase58 = config.solanaKeypairBase58;
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

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (res.status === 402 && !this.demoMode && this.keypairBase58) {
      const challenge = await res.json();
      throw new Error(`Payment Required: ${JSON.stringify(challenge)}`);
    }

    return await res.json();
  }

  async checkSplTokenRisk(mintAddress: string, riskProfile: string = "allow_regulated_stablecoins"): Promise<any> {
    return this.callEndpoint("/api/v1/crypto/solana-risk", {
      mint_address: mintAddress,
      risk_profile: riskProfile,
    });
  }

  async evaluate_solana_token_risk(mintAddress: string, riskProfile: string = "allow_regulated_stablecoins"): Promise<any> {
    return this.checkSplTokenRisk(mintAddress, riskProfile);
  }

  async auditSolanaProgram(code: string): Promise<any> {
    return this.callEndpoint("/api/v1/agent/contract-audit", {
      contract_code: code,
      language: "rust_anchor",
    });
  }

  async verifyGuardrail(input: string, context: string = ""): Promise<any> {
    return this.callEndpoint("/api/v1/agent/guardrail-verify", {
      input,
      context,
    });
  }
}

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
        "SOLANA_HONEYPOT_CHECK"
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
      validate: async () => true,
      handler: async (runtime: any, message: any, state: any, options: any, callback: any) => {
        const client = new DiogenesClient({ demoMode: true });
        const mint = message.content?.mintAddress || message.content?.text?.match(/[1-9A-HJ-NP-za-km-z]{32,44}/)?.[0];
        
        if (!mint) {
          callback?.({ text: "Please provide a valid Solana SPL token mint address to inspect." });
          return false;
        }

        try {
          const result = await client.checkSplTokenRisk(mint);
          const p = result.preview || {};
          const reasonStr = Array.isArray(p.reason_codes) && p.reason_codes.length > 0 ? p.reason_codes.join(", ") : "CLEAN";
          const standardStr = p.token_standard || "spl-token";
          const slotStr = p.slot ? ` | Slot: ${p.slot}` : "";
          callback?.({
            text: `Token Audit for ${mint}:\nVerdict: ${p.should_transact ? "SAFE" : "CAUTION"}\nRisk Score: ${p.risk_score ?? "Low"}\nStandard: ${standardStr}${slotStr}\nFreeze Authority: ${p.has_freeze_authority ? "ACTIVE" : "Disabled"}\nReason Codes: ${reasonStr}`,
            content: result,
          });
          return true;
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
        "VERIFY_SMART_CONTRACT"
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
      validate: async () => true,
      handler: async (runtime: any, message: any, state: any, options: any, callback: any) => {
        const client = new DiogenesClient({ demoMode: true });
        const code = message.content?.code || message.content?.text;
        
        try {
          const result = await client.auditSolanaProgram(code);
          callback?.({
            text: `Smart Contract Audit Result:\nVerdict: ${result.preview?.audit_passed ? "PASS" : "WARN"}\nVulnerabilities Found: ${result.preview?.vulnerabilities?.length ?? 0}`,
            content: result,
          });
          return true;
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
        "CHECK_PROMPT_INJECTION"
      ],
      description: "Pre-execution security gate to prevent prompt injection and destructive shell commands",
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
      validate: async () => true,
      handler: async (runtime: any, message: any, state: any, options: any, callback: any) => {
        const client = new DiogenesClient({ demoMode: true });
        const input = message.content?.text || "";
        const result = await client.verifyGuardrail(input);
        callback?.({ text: `Guardrail evaluated: ${result.preview?.verdict || "OK"}`, content: result });
        return true;
      },
    },
  ],
};

export const plugin = diogenesPlugin;
export default diogenesPlugin;
