/**
 * Deterministic, configurable git identity for coding sub-agent spawns.
 *
 * A coding sub-agent (claude / codex / opencode / elizaos / pi-agent) commits
 * inside its workspace. Without an explicit identity, git falls back to whatever
 * `user.name` / `user.email` the child's global/system `~/.gitconfig` (or
 * `EMAIL` / `GIT_AUTHOR_*` env) happens to carry — i.e. the operator's personal
 * identity leaks onto every agent commit, and on a fresh box git can outright
 * refuse to commit ("Please tell me who you are"). This module lets an operator
 * pin an explicit author/committer + a `Co-authored-by:` trailer for every
 * agent commit, deterministically, from the existing config surface.
 *
 * Materialization is pure `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env — the same
 * mechanism git itself documents — so it composes with the credential-proxy's
 * `GIT_CONFIG_*` block (that one sets `credential.helper`, this one sets
 * author/committer; disjoint keys, no collision) and needs no on-disk gitconfig.
 *
 * Fail-safe: when nothing is configured, {@link buildGitIdentityEnvPatch}
 * returns an empty patch and the spawn env is byte-identical to before — the
 * existing gitconfig-inheritance behavior is preserved exactly.
 *
 * @module services/git-identity-env
 */

/**
 * Config keys (read from the eliza config `env` section OR process.env via
 * {@link readConfigEnvKey}, so a UI / service.env / shell export all work and
 * take effect without a restart).
 *
 * - `ELIZA_CODING_GIT_AUTHOR_NAME` / `_EMAIL`: the commit author. When only the
 *   name is set, git still needs an email; we synthesize a stable no-reply email
 *   from the name so a half-configured identity never falls back to the leaky
 *   global one.
 * - `ELIZA_CODING_GIT_COMMITTER_NAME` / `_EMAIL`: the committer. Defaults to the
 *   author when unset (the common case: author == committer).
 * - `ELIZA_CODING_GIT_CO_AUTHOR`: one `Name <email>` co-author whose
 *   `Co-authored-by:` trailer the operating manual instructs the agent to append
 *   (provenance for the human/agent pairing). Documented, not force-injected,
 *   because the trailer must land in the commit *message* body, which only the
 *   agent (or a commit-msg hook) writes.
 */
export const GIT_IDENTITY_AUTHOR_NAME_KEY = "ELIZA_CODING_GIT_AUTHOR_NAME";
export const GIT_IDENTITY_AUTHOR_EMAIL_KEY = "ELIZA_CODING_GIT_AUTHOR_EMAIL";
export const GIT_IDENTITY_COMMITTER_NAME_KEY =
  "ELIZA_CODING_GIT_COMMITTER_NAME";
export const GIT_IDENTITY_COMMITTER_EMAIL_KEY =
  "ELIZA_CODING_GIT_COMMITTER_EMAIL";
export const GIT_IDENTITY_CO_AUTHOR_KEY = "ELIZA_CODING_GIT_CO_AUTHOR";

/** The resolved identity — every field optional so callers can branch on which
 * pieces an operator actually configured. */
export interface GitIdentityConfig {
  authorName?: string;
  authorEmail?: string;
  committerName?: string;
  committerEmail?: string;
  /** Raw `Name <email>` (or bare `Name`) string for the Co-authored-by trailer. */
  coAuthor?: string;
}

/** A source for identity values — a bare function so this module stays pure and
 * unit-testable (pass a synthetic lookup); production passes `readConfigEnvKey`. */
export type GitIdentityConfigSource = (key: string) => string | undefined;

function clean(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the configured coding git identity from a value source. Pure: no
 * process.env / config read of its own — pass `readConfigEnvKey` (or a synthetic
 * lookup in tests). Returns `undefined` when NOTHING is configured, so callers
 * can preserve current behavior exactly (see {@link buildGitIdentityEnvPatch}).
 */
export function resolveGitIdentityConfig(
  read: GitIdentityConfigSource,
): GitIdentityConfig | undefined {
  const authorName = clean(read(GIT_IDENTITY_AUTHOR_NAME_KEY));
  const authorEmail = clean(read(GIT_IDENTITY_AUTHOR_EMAIL_KEY));
  const committerName = clean(read(GIT_IDENTITY_COMMITTER_NAME_KEY));
  const committerEmail = clean(read(GIT_IDENTITY_COMMITTER_EMAIL_KEY));
  const coAuthor = clean(read(GIT_IDENTITY_CO_AUTHOR_KEY));
  if (
    !authorName &&
    !authorEmail &&
    !committerName &&
    !committerEmail &&
    !coAuthor
  ) {
    // Nothing configured — signal "no identity" so the spawn env is untouched.
    return undefined;
  }
  return {
    ...(authorName ? { authorName } : {}),
    ...(authorEmail ? { authorEmail } : {}),
    ...(committerName ? { committerName } : {}),
    ...(committerEmail ? { committerEmail } : {}),
    ...(coAuthor ? { coAuthor } : {}),
  };
}

/**
 * Derive a stable, non-routable no-reply email from a display name, used only
 * when a name is configured without an email. Keeps a half-configured identity
 * from silently falling back to the child's global `user.email` (the leak this
 * module exists to prevent) while never inventing a real-looking address.
 * `no-reply@elizaos.local` mirrors GitHub's `<login>@users.noreply.github.com`
 * convention with a clearly-local, unroutable domain.
 */
export function syntheticNoReplyEmail(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent";
  return `${slug}.no-reply@elizaos.local`;
}

/**
 * Materialize the resolved identity into a `GIT_AUTHOR_*` / `GIT_COMMITTER_*`
 * env patch. Returns an EMPTY object when `config` is undefined (nothing
 * configured) or carries no usable author/committer — so merging it into the
 * spawn env is a no-op and preserves the pre-existing gitconfig inheritance
 * exactly (the co-author-only case configures a trailer, not env identity).
 *
 * Only sets a `*_EMAIL` alongside a `*_NAME`: git requires both to accept an
 * explicit identity, so a name with no email (and none derivable) is dropped
 * rather than producing a half-set identity that git rejects mid-commit.
 * The committer defaults to the author when only the author is configured.
 */
export function buildGitIdentityEnvPatch(
  config: GitIdentityConfig | undefined,
): Record<string, string> {
  const patch: Record<string, string> = {};
  if (!config) return patch;

  // Resolve author + committer symmetrically. Whichever ROLE an operator
  // configured, BOTH GIT_AUTHOR_* and GIT_COMMITTER_* must be emitted together:
  // a committer-only config that left GIT_AUTHOR_* unset would still let git
  // resolve the author from the child's global config (the leak) or fail on a
  // fresh box ("Please tell me who you are") — exactly the failures this feature
  // exists to prevent. So a lone committer identity also seeds the author, and a
  // lone author identity also seeds the committer (the common author==committer
  // case).
  const authorName = config.authorName ?? config.committerName;
  const authorEmail =
    config.authorEmail ??
    config.committerEmail ??
    (authorName ? syntheticNoReplyEmail(authorName) : undefined);
  if (authorName && authorEmail) {
    patch.GIT_AUTHOR_NAME = authorName;
    patch.GIT_AUTHOR_EMAIL = authorEmail;
  }

  const committerName = config.committerName ?? authorName;
  // A DISTINCT committer name (explicitly configured) with no email gets a
  // synthetic email of its OWN rather than borrowing the author's — a separate
  // committer identity should read as separate. Only when the committer is
  // implicitly the author (no committerName configured) does it inherit the
  // author's email verbatim.
  const committerEmail =
    config.committerEmail ??
    (config.committerName
      ? syntheticNoReplyEmail(config.committerName)
      : authorEmail);
  if (committerName && committerEmail) {
    patch.GIT_COMMITTER_NAME = committerName;
    patch.GIT_COMMITTER_EMAIL = committerEmail;
  }

  return patch;
}

/** Regex-validate a `Name <email>` (or bare `Name`) co-author string and split
 * it. Returns undefined for empty/garbage so the manual never renders a broken
 * trailer line. */
export function parseCoAuthor(
  value: string | undefined,
): { name: string; email?: string } | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  const match = raw.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  if (match) {
    const name = match[1].trim();
    const email = match[2].trim();
    if (name.length === 0) return undefined;
    return email.length > 0 ? { name, email } : { name };
  }
  // Bare name with no angle-bracketed email — still a usable (if unconventional)
  // trailer subject.
  return { name: raw };
}

/**
 * Render the `Co-authored-by:` trailer line for the configured co-author, or
 * undefined when none is configured. The workspace operating manual embeds this
 * so the agent appends it to its commit message body (git's own trailer
 * convention: a `Co-authored-by: Name <email>` line in the last paragraph).
 */
export function renderCoAuthorTrailer(
  config: GitIdentityConfig | undefined,
): string | undefined {
  const parsed = parseCoAuthor(config?.coAuthor);
  if (!parsed) return undefined;
  const email = parsed.email ?? syntheticNoReplyEmail(parsed.name);
  return `Co-authored-by: ${parsed.name} <${email}>`;
}
