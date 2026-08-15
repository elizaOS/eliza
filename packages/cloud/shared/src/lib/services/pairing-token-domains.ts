/**
 * Resolves equivalent managed-agent origins for pairing-token validation.
 * Production and staging aliases are separate trust groups; when compatibility
 * suffixes overlap, the longest matching suffix owns the origin so a staging
 * agent can never be rewritten onto a production host.
 *
 * `.cloud.eliza.app` is canonical in production. The remaining production
 * suffixes are retained only while old pairing records expire. Personal or
 * otherwise retired domains are intentionally excluded and fail validation.
 */

import { ELIZA_DOMAIN_CONTRACTS, LEGACY_ELIZA_DOMAIN_CONTRACTS } from "@elizaos/shared/elizacloud";

export const DOMAIN_ALIAS_GROUPS: readonly (readonly string[])[] = [
  [
    ELIZA_DOMAIN_CONTRACTS.production.dedicatedAgentHostnameSuffix,
    LEGACY_ELIZA_DOMAIN_CONTRACTS.production.dedicatedAgentHostnameSuffix,
    ".waifu.fun",
    ".eliza.ai",
  ],
  [
    ELIZA_DOMAIN_CONTRACTS.staging.dedicatedAgentHostnameSuffix,
    LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.dedicatedAgentHostnameSuffix,
  ],
];

const MANAGED_AGENT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Given an origin like https://uuid.waifu.fun, return every other origin
 * that resolves to the same agent container under
 * {@link DOMAIN_ALIAS_GROUPS}. Empty array if the origin's hostname does
 * not match any aliased suffix, or if the input is not a parseable URL.
 */
export function getAlternateDomainOrigins(origin: string): string[] {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // error-policy:J3 Invalid origins are explicit non-matches.
    return [];
  }
  let bestMatch: { group: readonly string[]; suffix: string } | undefined;

  for (const group of DOMAIN_ALIAS_GROUPS) {
    for (const suffix of group) {
      if (
        url.hostname.endsWith(suffix) &&
        (!bestMatch || suffix.length > bestMatch.suffix.length)
      ) {
        bestMatch = { group, suffix };
      }
    }
  }

  if (!bestMatch) return [];

  const { group, suffix } = bestMatch;
  const prefix = url.hostname.slice(0, -suffix.length);
  // Managed-agent hosts are flat: `<agent-id><suffix>`. Refusing a nested
  // prefix prevents labels such as `staging` from being smuggled through a
  // broader production suffix and crossing the environment trust boundary.
  if (!MANAGED_AGENT_LABEL.test(prefix)) return [];

  return group
    .filter((candidate) => candidate !== suffix)
    .map((candidate) => {
      const alternate = new URL(url);
      alternate.hostname = prefix + candidate;
      return alternate.origin;
    });
}
