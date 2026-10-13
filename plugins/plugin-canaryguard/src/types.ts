export interface CryptoAddressFinding {
  address: string;
  risk_score: number;
  reasons: string[];
  chain?: "evm" | "solana";
}

export interface CanaryGuardResult {
  status: "clean" | "sanitized" | "blocked";
  risk_score: number;
  injection_detected: boolean;
  threats_neutralized: string[];
  crypto_addresses: CryptoAddressFinding[];
  sanitized_content: string;
  safety_receipt: string;
  mode: "local" | "remote" | "local-fallback";
  remote_error?: string;
  inspection: {
    method: string;
    guaranteed_safe: boolean;
    risk_score_semantics: string;
    limitations: string[];
  };
}

export interface CanaryGuardConfig {
  serviceUrl?: string;
  strictMode?: boolean;
  paymentHeader?: string;
}
