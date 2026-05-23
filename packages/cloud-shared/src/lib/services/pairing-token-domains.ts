// Domain alias groups — all domains in a group resolve to the same agent
// container. Each agent's public URL may be rewritten between any two
// domains in the same group (e.g. the dashboard generates an
// `<uuid>.elizacloud.ai` link but the agent was originally provisioned with
// an `<uuid>.waifu.fun` Origin), so token validation tries every alias.
//
// `.elizacloud.ai` is the canonical post-2026-05 brand; the others are
// kept during the rebrand grace period and can be retired one by one once
// no DB rows reference them.
//
// Pure data + pure function — extracted from `pairing-token.ts` so the
// alias logic stays unit-testable without pulling the Postgres repository
// import chain.

export const DOMAIN_ALIAS_GROUPS: readonly (readonly string[])[] = [
  [".waifu.fun", ".eliza.ai", ".elizacloud.ai", ".milady.ai", ".shad0w.xyz"],
];

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
    return [];
  }
  for (const group of DOMAIN_ALIAS_GROUPS) {
    const matched = group.find((suffix) => url.hostname.endsWith(suffix));
    if (!matched) continue;
    const alternates: string[] = [];
    for (const candidate of group) {
      if (candidate === matched) continue;
      const altUrl = new URL(url.toString());
      altUrl.hostname = url.hostname.replace(
        new RegExp(`${matched.replaceAll(".", "\\.")}$`),
        candidate,
      );
      alternates.push(altUrl.origin);
    }
    return alternates;
  }
  return [];
}
