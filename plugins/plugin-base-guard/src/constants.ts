import { GuardPolicy } from "./types.js";

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".toLowerCase();

export const DANGEROUS_SELECTORS: Record<string, string> = {
  "0xf2fde38b": "transferOwnership(address)",
  "0x715018a6": "renounceOwnership()",
  "0x4f1ee3d0": "upgradeToAndCall(address,bytes)",
  "0x3659cfe6": "upgradeTo(address)",
  "0x42966c68": "burn(uint256)",
  "0xac9650d8": "multicall(bytes[])",
  "0x5ae401dc": "multicall(uint256,bytes[])",
  "0x39506948": "increaseAllowance(address,uint256)",
  "0xd505accf": "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "0x83197ef0": "destroy() / selfdestruct",
};

export const PROMPT_INJECTION_PATTERNS = [
  { pattern: /ignore\s+(all\s+)?(previous\s+)?instructions/i, name: "Instruction Override" },
  { pattern: /disregard\s+(the\s+)?(safety|system|guard)/i, name: "Safety Bypass Attempt" },
  { pattern: /bypass\s+(the\s+)?(policy|firewall|guardrail|limits)/i, name: "Policy Bypass Attempt" },
  { pattern: /drain\s+(the\s+)?(wallet|balance|funds|vault)/i, name: "Wallet Drain Command" },
  { pattern: /transfer\s+all\s+(funds|eth|usdc|tokens|balance)/i, name: "Total Transfer Command" },
  { pattern: /send\s+(entire|all|whole)\s+(balance|funds|tokens)/i, name: "Exhaustive Send Command" },
  { pattern: /system:\s*override/i, name: "System Prefix Impersonation" },
  { pattern: /admin\s+mode\s+enabled/i, name: "Fake Admin Escalation" },
];

export const DEFAULT_GUARD_POLICY: GuardPolicy = {
  maxNativePerTx: "0.05", // 0.05 ETH
  maxNativeDaily: "0.20", // 0.20 ETH
  maxUsdcPerTx: "50.0",   // 50 USDC
  maxUsdcDaily: "200.0",  // 200 USDC
  maxPaymentPerX402: "5.0", // 5 USDC
  blockedDestinations: [
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
  ],
  strictMode: true,
};
