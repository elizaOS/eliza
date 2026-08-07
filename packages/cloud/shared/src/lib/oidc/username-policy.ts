/**
 * Naming policy for the frozen `preferred_username` claim: normalization, the
 * reserved-name denylist, and candidate ordering.
 *
 * Split from the allocator (`./username.ts`) so the rules stay a pure,
 * dependency-free function. They are a one-way door — the relying party turns
 * the winning value into a permanent account name and links future logins on
 * it — so they are worth testing without a database in the way.
 */

const MIN_LENGTH = 2;
export const MAX_USERNAME_LENGTH = 32;

/**
 * Names an SSO user must not be able to claim. Operational accounts
 * (`eliza-merge-steward`, the local recovery admin) and the relying party's own
 * reserved top-level routes are the ones that matter — squatting either would
 * let an ordinary login take over a name the deployment depends on.
 */
const RESERVED_USERNAMES = new Set([
  "admin",
  "administrator",
  "api",
  "assets",
  "attachments",
  "avatar",
  "avatars",
  "captcha",
  "commits",
  "debug",
  "devtest",
  "eliza-merge-steward",
  "elizacloud",
  "error",
  "explore",
  "favicon",
  "forgejo",
  "ghost",
  "gitea",
  "graphs",
  "healthz",
  "help",
  "issues",
  "login",
  "logout",
  "manifest",
  "metrics",
  "milestones",
  "new",
  "notifications",
  "oauth",
  "oidc",
  "org",
  "orgs",
  "owner",
  "pulls",
  "raw",
  "repo",
  "repos",
  "robots",
  "root",
  "search",
  "security",
  "signup",
  "ssh",
  "steward",
  "support",
  "swagger",
  "system",
  "user",
  "users",
  "v2",
  "webhook",
  "well-known",
]);

export interface UsernameSeed {
  id: string;
  nickname?: string | null;
  name?: string | null;
  email?: string | null;
}

/**
 * Reduce arbitrary text to `[a-z0-9][a-z0-9._-]*[a-z0-9]`, the intersection of
 * what the relying party accepts and what is safe in a URL path segment.
 * Returns null when nothing usable survives.
 */
export function normalizeUsernameCandidate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const collapsed = raw
    .normalize("NFKD")
    // Drop combining marks so an accented name folds to its ASCII base rather
    // than losing the whole letter to the non-alphanumeric sweep below.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[-._]{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, MAX_USERNAME_LENGTH)
    .replace(/[-._]+$/g, "");

  if (collapsed.length < MIN_LENGTH) return null;
  if (!/^[a-z0-9]/.test(collapsed)) return null;
  if (RESERVED_USERNAMES.has(collapsed)) return null;
  return collapsed;
}

function fallbackUsername(userId: string): string {
  const compact = userId.replace(/-/g, "").slice(0, 12);
  return `eliza-${compact || "user"}`;
}

/**
 * Ordered candidates, best first, always ending with an id-derived value that
 * cannot fail normalization — so no user is locked out of SSO by an unusable
 * nickname. The email local part is used only when the user set no display
 * name; it does leak an email prefix into a public account name, which is the
 * accepted cost of the relying party needing a human-recognizable username.
 */
export function deriveUsernameCandidates(seed: UsernameSeed): string[] {
  const localPart = seed.email?.includes("@") ? seed.email.split("@")[0] : null;
  const candidates = [
    normalizeUsernameCandidate(seed.nickname),
    normalizeUsernameCandidate(localPart),
    normalizeUsernameCandidate(seed.name),
    normalizeUsernameCandidate(fallbackUsername(seed.id)),
  ].filter((candidate): candidate is string => candidate !== null);

  return [...new Set(candidates)];
}

/** Append a disambiguating suffix while staying inside the length limit. */
export function usernameWithSuffix(base: string, suffix: number): string {
  const tag = `-${suffix}`;
  const trimmed = base.slice(0, MAX_USERNAME_LENGTH - tag.length).replace(/[-._]+$/g, "");
  return `${trimmed || "eliza"}${tag}`;
}
