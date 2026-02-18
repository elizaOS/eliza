export type FlagSeverity = "critical" | "high" | "medium" | "info";

export interface FlagInfo {
  flag: string;
  severity: FlagSeverity;
  description: string;
}

const FLAG_MAP: Record<string, FlagInfo> = {
  // Critical - service should not be used
  WALLET_SPAM_FARM: {
    flag: "WALLET_SPAM_FARM",
    severity: "critical",
    description: "Wallet associated with 100+ services - likely spam farm",
  },
  ENDPOINT_DOWN: {
    flag: "ENDPOINT_DOWN",
    severity: "critical",
    description: "Service endpoint is unreachable",
  },
  FIDELITY_FAILING: {
    flag: "FIDELITY_FAILING",
    severity: "critical",
    description: "Service fails fidelity checks - does not deliver what it advertises",
  },

  // High - proceed with caution
  TEMPLATE_SPAM: {
    flag: "TEMPLATE_SPAM",
    severity: "high",
    description: "Generic template description - likely auto-generated service",
  },
  PRICE_MISMATCH: {
    flag: "PRICE_MISMATCH",
    severity: "high",
    description: "Advertised price does not match actual x402 payment amount",
  },
  NETWORK_MISMATCH: {
    flag: "NETWORK_MISMATCH",
    severity: "high",
    description: "Advertised network does not match actual x402 payment network",
  },
  WALLET_MISMATCH: {
    flag: "WALLET_MISMATCH",
    severity: "high",
    description: "Advertised wallet does not match actual x402 payment address",
  },

  // Medium - notable issues
  ENDPOINT_TIMEOUT: {
    flag: "ENDPOINT_TIMEOUT",
    severity: "medium",
    description: "Service endpoint responds but with excessive latency",
  },
  SCHEMA_PHANTOM: {
    flag: "SCHEMA_PHANTOM",
    severity: "medium",
    description: "Service claims to have a schema but none was found",
  },
  MISSING_SCHEMA: {
    flag: "MISSING_SCHEMA",
    severity: "medium",
    description: "No API schema provided - response format unknown",
  },
  NOT_X402: {
    flag: "NOT_X402",
    severity: "medium",
    description: "Endpoint does not implement the x402 payment protocol",
  },
  MISSING_RESOURCE_URL: {
    flag: "MISSING_RESOURCE_URL",
    severity: "medium",
    description: "No resource URL specified for the service",
  },
  UNCLEAR_PRICING: {
    flag: "UNCLEAR_PRICING",
    severity: "medium",
    description: "Service pricing is ambiguous or not clearly defined",
  },
  POOR_DESCRIPTION: {
    flag: "POOR_DESCRIPTION",
    severity: "medium",
    description: "Service description is too short or uninformative",
  },
  NO_CONTRACT_DATA: {
    flag: "NO_CONTRACT_DATA",
    severity: "medium",
    description: "No x402 contract data found in response",
  },
  MALFORMED_RESPONSE: {
    flag: "MALFORMED_RESPONSE",
    severity: "medium",
    description: "Service returns malformed or unparseable response",
  },

  // Info - positive indicators
  HAS_COMPLETE_SCHEMA: {
    flag: "HAS_COMPLETE_SCHEMA",
    severity: "info",
    description: "Service provides a complete API schema",
  },
  GOOD_DOCUMENTATION: {
    flag: "GOOD_DOCUMENTATION",
    severity: "info",
    description: "Service has quality documentation",
  },
  PROTOCOL_COMPLIANT: {
    flag: "PROTOCOL_COMPLIANT",
    severity: "info",
    description: "Fully compliant with x402 payment protocol",
  },
  CONTRACT_VERIFIED: {
    flag: "CONTRACT_VERIFIED",
    severity: "info",
    description: "All contract fields match between advertised and actual",
  },
  SCHEMA_VERIFIED: {
    flag: "SCHEMA_VERIFIED",
    severity: "info",
    description: "Schema claims verified against actual response",
  },
  FIDELITY_PROVEN: {
    flag: "FIDELITY_PROVEN",
    severity: "info",
    description: "Service passes fidelity checks with score >= 80",
  },
  SELF_DOCUMENTING: {
    flag: "SELF_DOCUMENTING",
    severity: "info",
    description: "Response includes schema and documentation",
  },
  X402_V1: {
    flag: "X402_V1",
    severity: "info",
    description: "Uses x402 protocol version 1",
  },
  X402_V2: {
    flag: "X402_V2",
    severity: "info",
    description: "Uses x402 protocol version 2",
  },
};

export function interpretFlag(flag: string): FlagInfo {
  return (
    FLAG_MAP[flag] || {
      flag,
      severity: "medium" as FlagSeverity,
      description: `Unknown flag: ${flag}`,
    }
  );
}

export function interpretFlags(flags: string[]): FlagInfo[] {
  return flags.map(interpretFlag);
}

export function getWarningFlags(flags: string[]): FlagInfo[] {
  return interpretFlags(flags).filter(
    (f) => f.severity === "critical" || f.severity === "high"
  );
}

export function hasAutoRejectFlag(
  flags: string[],
  autoRejectList: string[]
): boolean {
  return flags.some((f) => autoRejectList.includes(f));
}

export function formatFlagsForDisplay(flags: string[]): string {
  const interpreted = interpretFlags(flags);
  if (interpreted.length === 0) return "No flags.";

  const warnings = interpreted.filter(
    (f) => f.severity === "critical" || f.severity === "high"
  );
  const info = interpreted.filter(
    (f) => f.severity === "info"
  );

  const parts: string[] = [];
  if (warnings.length > 0) {
    parts.push(
      "Warnings: " +
        warnings.map((f) => `${f.flag} (${f.description})`).join(", ")
    );
  }
  if (info.length > 0) {
    parts.push("Positives: " + info.map((f) => f.flag).join(", "));
  }
  return parts.join(". ");
}