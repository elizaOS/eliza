/**
 * Shared normalization for owner-profile facts that arrive through either the
 * zero-cost chat regex extractor or the core fact-memory projection. Keeping
 * role mapping and identity cleanup here prevents the passive-learning paths
 * from drifting while they feed the same OwnerFactStore and graph stores.
 */

export const RELATIONSHIP_TYPE_BY_ROLE: Record<string, string> = {
  boss: "managed_by",
  manager: "managed_by",
  supervisor: "managed_by",
  lead: "managed_by",
  partner: "partner_of",
  spouse: "partner_of",
  husband: "partner_of",
  wife: "partner_of",
  colleague: "colleague_of",
  coworker: "colleague_of",
  teammate: "colleague_of",
  friend: "knows",
  doctor: "care_provider",
  therapist: "care_provider",
  coach: "care_provider",
};

export function cleanName(raw: string | undefined): string | null {
  const value = raw?.replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
  if (!value || value.length < 2 || value.length > 80) return null;
  if (/^(?:me|my|mine|you|them|someone|somebody|at|on)$/iu.test(value)) {
    return null;
  }
  return value;
}

export function cleanHandle(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/[),.;!?]+$/u, "");
  if (!value || value.length < 2 || value.length > 120) return null;
  return value;
}

export function normalizePlatform(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "twitter") return "x";
  return normalized;
}

export function relationTypeForRole(role: string | null): string | null {
  if (!role) return null;
  return RELATIONSHIP_TYPE_BY_ROLE[role.toLowerCase()] ?? role.toLowerCase();
}
