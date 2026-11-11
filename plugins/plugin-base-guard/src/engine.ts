import { decodeFunctionData, formatEther, formatUnits, getAddress, isAddress, parseAbi, parseEther, parseUnits } from "viem";
import {
  BASE_SEPOLIA_USDC,
  BASE_USDC,
  DANGEROUS_SELECTORS,
  PROMPT_INJECTION_PATTERNS,
} from "./constants.js";
import { GuardPolicy, SecurityVerdict, TransactionInput, X402Challenge } from "./types.js";

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const UNLIMITED_APPROVAL_THRESHOLD = BigInt(
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
) - BigInt(1000000);

interface SpendRecord {
  timestamp: number;
  asset: "NATIVE" | string;
  amount: bigint;
}

export class BaseGuardEngine {
  private policy: GuardPolicy;
  private spendHistory: SpendRecord[] = [];
  private blocklistSet: Set<string>;

  constructor(policy: GuardPolicy) {
    this.policy = policy;
    this.blocklistSet = new Set(policy.blockedDestinations.map(d => d.toLowerCase()));
  }

  public getPolicy(): GuardPolicy {
    return this.policy;
  }

  public get24hNativeUsed(now: number = Date.now()): bigint {
    const cutoff = now - 24 * 60 * 60 * 1000;
    return this.spendHistory
      .filter(item => item.asset === "NATIVE" && item.timestamp >= cutoff)
      .reduce((acc, item) => acc + item.amount, BigInt(0));
  }

  public scanPrompt(text?: string): { safe: boolean; pattern?: string; riskScore: number } {
    if (!text) return { safe: true, riskScore: 0 };
    for (const item of PROMPT_INJECTION_PATTERNS) {
      if (item.pattern.test(text)) {
        return { safe: false, pattern: item.name, riskScore: 90 };
      }
    }
    return { safe: true, riskScore: 0 };
  }

  public evaluateTransaction(input: TransactionInput, now: number = Date.now()): SecurityVerdict {
    const timestamp = now;

    // 1. Scan for prompt injection
    const combined = `${input.userPrompt || ""} ${input.reasoningTrace || ""}`.trim();
    if (combined) {
      const scan = this.scanPrompt(combined);
      if (!scan.safe) {
        return {
          allowed: false,
          code: "PROMPT_INJECTION_DETECTED",
          riskScore: scan.riskScore,
          reason: `Transaction blocked: Prompt injection attempt detected (${scan.pattern}).`,
          timestamp,
        };
      }
    }

    // 2. Validate destination address
    if (!isAddress(input.to)) {
      return {
        allowed: false,
        code: "INVALID_DESTINATION",
        riskScore: 90,
        reason: `Target address '${input.to}' is not a valid Ethereum address.`,
        timestamp,
      };
    }

    const normalizedTo = input.to.toLowerCase();
    if (this.blocklistSet.has(normalizedTo)) {
      return {
        allowed: false,
        code: "DESTINATION_BLOCKLISTED",
        riskScore: 100,
        reason: `Target destination '${input.to}' is in the security blocklist.`,
        timestamp,
      };
    }

    // 3. Inspect calldata
    if (input.data && input.data !== "0x" && input.data.length >= 10) {
      const selector = input.data.slice(0, 10).toLowerCase();
      if (DANGEROUS_SELECTORS[selector]) {
        return {
          allowed: false,
          code: "DANGEROUS_CALLDATA",
          riskScore: 95,
          reason: `Blocked critical dangerous selector: ${DANGEROUS_SELECTORS[selector]} (${selector}).`,
          timestamp,
        };
      }

      try {
        const decoded = decodeFunctionData({
          abi: ERC20_ABI,
          data: input.data as `0x${string}`,
        });

        if (decoded.functionName === "approve") {
          const [, amount] = decoded.args as [string, bigint];
          if (amount >= UNLIMITED_APPROVAL_THRESHOLD) {
            return {
              allowed: false,
              code: "UNLIMITED_APPROVAL_ATTACK",
              riskScore: 90,
              reason: "Blocked unbounded/unlimited ERC-20 approval attack. Allowances must be finite and capped.",
              timestamp,
            };
          }
        }

        if (decoded.functionName === "transfer") {
          const [, amount] = decoded.args as [string, bigint];
          const isUsdc = normalizedTo === BASE_USDC || normalizedTo === BASE_SEPOLIA_USDC;
          const decimals = isUsdc ? 6 : 18;
          const limitUnits = parseUnits(this.policy.maxUsdcPerTx, decimals);

          if (amount > limitUnits) {
            return {
              allowed: false,
              code: "EXCEEDS_SPEND_LIMIT",
              riskScore: 80,
              reason: `Token transfer (${formatUnits(amount, decimals)}) exceeds per-tx limit of ${this.policy.maxUsdcPerTx} USDC.`,
              timestamp,
            };
          }
        }
      } catch {
        // Not a standard ERC20 call, proceed to native check
      }
    }

    // 4. Validate native spend limits
    if (input.value && input.value !== "0" && input.value !== "0x" && input.value !== "0x0") {
      let valueWei: bigint;
      try {
        valueWei = input.value.includes(".") ? parseEther(input.value) : BigInt(input.value);
      } catch {
        return {
          allowed: false,
          code: "MALFORMED_VALUE",
          riskScore: 85,
          reason: `Malformed native value: ${input.value}`,
          timestamp,
        };
      }

      const maxPerTxWei = parseEther(this.policy.maxNativePerTx);
      if (valueWei > maxPerTxWei) {
        return {
          allowed: false,
          code: "EXCEEDS_SPEND_LIMIT",
          riskScore: 80,
          reason: `Native transfer ${formatEther(valueWei)} ETH exceeds per-tx ceiling of ${this.policy.maxNativePerTx} ETH.`,
          timestamp,
        };
      }

      const dailyUsed = this.get24hNativeUsed(now);
      const maxDailyWei = parseEther(this.policy.maxNativeDaily);
      if (dailyUsed + valueWei > maxDailyWei) {
        return {
          allowed: false,
          code: "EXCEEDS_SPEND_LIMIT",
          riskScore: 80,
          reason: `Cumulative 24h spend (${formatEther(dailyUsed + valueWei)} ETH) exceeds daily limit of ${this.policy.maxNativeDaily} ETH.`,
          timestamp,
        };
      }

      this.spendHistory.push({ timestamp: now, asset: "NATIVE", amount: valueWei });
    }

    return {
      allowed: true,
      code: "APPROVED",
      riskScore: 0,
      reason: "Transaction passed all fail-closed guardrails, calldata rules, and spend limits.",
      timestamp,
      diagnostics: {
        destination: getAddress(input.to),
      },
    };
  }

  public evaluateX402(challenge: X402Challenge, now: number = Date.now()): SecurityVerdict {
    const timestamp = now;
    const nowSec = Math.floor(now / 1000);

    if (!isAddress(challenge.merchant)) {
      return {
        allowed: false,
        code: "X402_MALFORMED",
        riskScore: 80,
        reason: `Invalid merchant Ethereum address: ${challenge.merchant}`,
        timestamp,
      };
    }

    if (challenge.deadline < nowSec) {
      return {
        allowed: false,
        code: "X402_EXPIRED",
        riskScore: 75,
        reason: `x402 challenge expired at timestamp ${challenge.deadline}.`,
        timestamp,
      };
    }

    const requestedAmount = parseFloat(challenge.amountUsdc);
    const maxAllowed = parseFloat(this.policy.maxPaymentPerX402);
    if (isNaN(requestedAmount) || requestedAmount > maxAllowed) {
      return {
        allowed: false,
        code: "X402_EXCEEDS_CAP",
        riskScore: 80,
        reason: `x402 payment of ${challenge.amountUsdc} USDC exceeds ceiling of ${this.policy.maxPaymentPerX402} USDC.`,
        timestamp,
      };
    }

    return {
      allowed: true,
      code: "APPROVED",
      riskScore: 0,
      reason: `x402 payment approved under ${this.policy.maxPaymentPerX402} USDC cap.`,
      timestamp,
      diagnostics: {
        merchant: getAddress(challenge.merchant),
        amountUsdc: challenge.amountUsdc,
      },
    };
  }
}
