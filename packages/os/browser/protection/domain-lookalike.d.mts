/** Suspicion only: callers retain reference domains and warning policy. */
export function detectDomainLookalike(
  address: string,
  knownSites: readonly string[],
): { status: "lookalike"; suggested: string; reason: "similar-domain" } | null;
