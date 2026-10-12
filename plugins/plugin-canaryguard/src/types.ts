export interface CanaryGuardResult {
  status: "clean" | "sanitized" | "blocked";
  risk_score: number;
  injection_detected: boolean;
  threats_neutralized: string[];
  crypto_addresses: Array<{ address: string; risk_score: number; reasons: string[] }>;
  sanitized_content: string;
  safety_receipt: string;
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
