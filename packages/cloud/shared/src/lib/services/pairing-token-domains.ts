// Domain alias groups — all domains in a group resolve to the same agent
// container. Each agent's public URL may be rewritten between any two
// domains in the same group (e.g. the dashboard generates an
// `<uuid>.cloud.eliza.app` link but the agent was originally provisioned with
// an `<uuid>.waifu.fun` Origin), so token validation tries every alias.
//
// `.cloud.eliza.app` is canonical; `.elizacloud.ai`, `.waifu.fun`, and
// `.eliza.ai` are retained only while old pairing records expire
// once no DB rows reference them.
//
// Intentionally NOT in this list:
//   - `.shad0w.xyz` — personal handle from the 0xSolace stack, never
//     served real production sandbox URLs
// Retired domains are part of the zero-compatibility-domain goal; old bookmarks
// under them will fail Origin validation, which is the intended outcome.
//
// Pure data + pure function — extracted from `pairing-token.ts` so the
// alias logic stays unit-testable without pulling the Postgres repository
// import chain.

export const DOMAIN_ALIAS_GROUPS: readonly (readonly string[])[] = [
  [".cloud.eliza.app", ".elizacloud.ai", ".waifu.fun", ".eliza.ai"],
  [".cloud-staging.eliza.app", ".staging.elizacloud.ai"],
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
    const prefix = url.hostname.slice(0, -matched.length);
    const alternates: string[] = [];
    for (const candidate of group) {
      if (candidate === matched) continue;
      const altUrl = new URL(url);
      altUrl.hostname = prefix + candidate;
      alternates.push(altUrl.origin);
    }
    return alternates;
  }
  return [];
}
