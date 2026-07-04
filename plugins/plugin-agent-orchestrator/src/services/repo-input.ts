/**
 * Repository input normalization for coding task workspaces.
 *
 * Accepts canonical clone URLs plus common shorthand forms such as:
 * - owner/repo
 * - github.com/owner/repo
 * - https://github.com/owner/repo
 *
 * Bare owner/repo inputs default to GitHub because the coding workspace
 * flows in this plugin are GitHub-centric.
 *
 * @module services/repo-input
 */

const KNOWN_GIT_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function normalizePathSegments(pathname: string): string[] {
  return pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function toHttpsCloneUrl(host: string, owner: string, repo: string): string {
  return `https://${host}/${owner}/${repo}.git`;
}

export function normalizeRepositoryInput(repo: string): string {
  const trimmed = repo.trim();
  if (!trimmed) return trimmed;

  // Preserve SSH-style clone URLs; they are already explicit and may be
  // intentionally configured to bypass HTTPS auth.
  if (/^[^@\s]+@[^:\s]+:[^/\s]+\/[^/\s]+(?:\.git)?$/i.test(trimmed)) {
    return trimmed;
  }

  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");

  if (/^https?:\/\//i.test(withoutTrailingSlash)) {
    try {
      const parsed = new URL(withoutTrailingSlash);
      const host = parsed.hostname.toLowerCase();
      if (KNOWN_GIT_HOSTS.has(host)) {
        const segments = normalizePathSegments(parsed.pathname);
        if (segments.length >= 2) {
          const owner = segments[0];
          const repoName = stripGitSuffix(segments[1]);
          return toHttpsCloneUrl(host, owner, repoName);
        }
      }
    } catch {
      // error-policy:J3 untrusted repo input; URL parse failure → pass raw through to downstream assertSafeGitRemote validation
      return withoutTrailingSlash;
    }
    return withoutTrailingSlash;
  }

  const hostMatch = withoutTrailingSlash.match(
    /^(github\.com|gitlab\.com|bitbucket\.org)\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
  );
  if (hostMatch) {
    return toHttpsCloneUrl(
      hostMatch[1].toLowerCase(),
      hostMatch[2],
      stripGitSuffix(hostMatch[3]),
    );
  }

  const shorthandMatch = withoutTrailingSlash.match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  if (shorthandMatch) {
    return toHttpsCloneUrl(
      "github.com",
      shorthandMatch[1],
      stripGitSuffix(shorthandMatch[2]),
    );
  }

  return withoutTrailingSlash;
}

/** Thrown by {@link assertSafeGitRemote} when a repo string is unsafe to hand
 * to `git` as a positional remote argument. */
export class UnsafeGitRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeGitRemoteError";
  }
}

// A remote-helper transport prefix like `ext::`, `fd::`, `foo::` — the `ext`
// helper executes an arbitrary shell command, so `git clone 'ext::sh -c "…"'`
// is remote code execution. Matches a scheme-like leading token immediately
// followed by `::`. Deliberately does NOT match IPv6 URL literals such as
// `https://[::1]/repo` (there the `::` is not preceded by a bare leading token).
const GIT_TRANSPORT_HELPER_RE = /^[A-Za-z][A-Za-z0-9+.-]*::/;
// Shell metacharacters and whitespace have no place in a real git remote URL
// (`https://host/owner/repo.git` or scp-style `user@host:path`). The lower-level
// `git-workspace-service` clones public repos through a SHELL
// (`promisify(exec)`, no quoting), so a remote like
// `https://x/y; touch /tmp/pwned` is command-injection RCE even though its
// `https://` prefix looks valid. Rejecting these keeps a single validated string
// safe whether the downstream spawn uses `execFile` (argv) or a shell. `[`/`]`
// are intentionally allowed so IPv6 URL literals (`https://[2001:db8::1]/…`) pass.
const SHELL_UNSAFE_RE = /[\s"'`\\;|&$(){}<>*?~#!]/;
// Only https / http / ssh URL transports are allowed. `file:` (local repo
// disclosure) and `git:` (unauthenticated, MITM-able) are rejected.
const ALLOWED_GIT_URL_SCHEME_RE = /^(?:https?|ssh):\/\//i;
// scp-style SSH remote: `[user@]host:path`, with a single `:` (not `::`, which
// would be a transport helper) and no whitespace.
const SCP_LIKE_REMOTE_RE = /^[^\s@:]+@[^\s:]+:(?!:)[^\s]+$/;

/**
 * Validate that a repository string is safe to pass to `git` as a positional
 * remote argument, returning it unchanged when safe and throwing
 * {@link UnsafeGitRemoteError} otherwise.
 *
 * The coding orchestrator clones repos on behalf of sub-agents whose task text
 * is model/attacker-influenced. Without this gate a repo string reaches
 * `git clone` / `git ls-remote` verbatim, and git exposes several code-exec /
 * disclosure vectors through the remote argument:
 *  - `ext::sh -c "…"` (and any `<helper>::…`) runs an arbitrary command;
 *  - a leading `-` (e.g. `--upload-pack=…`) is parsed as a git *option*
 *    (argument injection), since `execFile` does not add a `--` separator;
 *  - `file://…` clones an arbitrary local repository (info disclosure);
 *  - shell metacharacters / whitespace (`https://x/y; touch /tmp/pwned`) inject
 *    commands on the unauthenticated clone path, which the lower-level
 *    `git-workspace-service` runs through a shell (`promisify(exec)`).
 *
 * Callers MUST also spawn git with `GIT_ALLOW_PROTOCOL` restricted and a `--`
 * separator — this function is the application-level allowlist half of that
 * defense-in-depth pair.
 */
export function assertSafeGitRemote(repo: string): string {
  const value = repo.trim();
  if (!value) {
    throw new UnsafeGitRemoteError("Git remote is empty.");
  }
  if (value.startsWith("-")) {
    throw new UnsafeGitRemoteError(
      `Git remote may not begin with "-" (argument injection): ${repo}`,
    );
  }
  if (GIT_TRANSPORT_HELPER_RE.test(value)) {
    throw new UnsafeGitRemoteError(
      `Git remote uses an unsupported transport helper (e.g. ext::/fd::): ${repo}`,
    );
  }
  if (SHELL_UNSAFE_RE.test(value)) {
    throw new UnsafeGitRemoteError(
      `Git remote contains shell metacharacters or whitespace (command injection): ${repo}`,
    );
  }
  if (ALLOWED_GIT_URL_SCHEME_RE.test(value) || SCP_LIKE_REMOTE_RE.test(value)) {
    return value;
  }
  throw new UnsafeGitRemoteError(
    `Git remote is not an https/http/ssh URL or an ssh scp-style remote: ${repo}`,
  );
}

/** Thrown by {@link assertSafeGitRef} when a branch / ref name is unsafe to
 * interpolate into a git command. */
export class UnsafeGitRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeGitRefError";
  }
}

// A conservative allowlist for git branch / ref names: a leading alphanumeric
// followed by alphanumerics and `. _ / -`. This is a strict subset of what
// `git check-ref-format` permits, chosen so the value is safe to interpolate
// into a shell command. It rejects a leading `-` (argument injection), all
// whitespace, and every shell metacharacter, while accepting ordinary names
// like `main`, `develop`, `feature/foo-bar`, and `release/1.2.3`.
const SAFE_GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Validate that a branch / ref name is safe to interpolate into a git command,
 * returning it unchanged when safe and throwing {@link UnsafeGitRefError}
 * otherwise.
 *
 * The orchestrator auto-mints branch names through a sanitizer, but callers can
 * also supply `baseBranch` / `branchName` directly (HTTP `POST /api/workspace/
 * provision` body, action content). Those bypass the mint and flow raw into
 * `git clone --branch …`, `git fetch origin …`, `git checkout -b …`, and
 * `git worktree add -b …`, which the lower-level `git-workspace-service` runs
 * through a shell — so an unvalidated ref like `main; touch /tmp/pwned` is
 * command-injection RCE.
 */
export function assertSafeGitRef(ref: string, label = "git ref"): string {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new UnsafeGitRefError(`${label} is empty.`);
  }
  if (!SAFE_GIT_REF_RE.test(ref)) {
    throw new UnsafeGitRefError(
      `${label} contains characters that are not allowed in a git ref name (letters, digits, ".", "_", "/", "-"; no leading "-"): ${ref}`,
    );
  }
  return ref;
}

export function diagnoseWorkspaceBootstrapFailure(
  repo: string,
  errorMessage: string,
): string {
  const normalizedRepo = normalizeRepositoryInput(repo);

  if (
    normalizedRepo !== repo &&
    /could not resolve host|not appear to be a git repository|invalid repo/i.test(
      errorMessage,
    )
  ) {
    return (
      `The repo reference looked malformed for a clone. ` +
      `Expected a real Git remote such as ${normalizedRepo}.`
    );
  }

  if (
    /repository not found|not found/i.test(errorMessage) &&
    !/file not found/i.test(errorMessage)
  ) {
    return (
      `The repository could not be found or is not readable. ` +
      `Verify the repo exists and that the configured Git credentials can access it.`
    );
  }

  if (
    /authentication failed|permission denied|could not read username|terminal prompts disabled|access denied/i.test(
      errorMessage,
    )
  ) {
    return (
      `Workspace bootstrap reached the provider but Git authentication failed. ` +
      `Verify the configured PAT, OAuth session, or SSH key for repository access.`
    );
  }

  if (
    /could not resolve host|name or service not known|getaddrinfo/i.test(
      errorMessage,
    )
  ) {
    return (
      `Workspace bootstrap failed on DNS or network resolution. ` +
      `Verify the clone host is valid and reachable from this machine.`
    );
  }

  return (
    `Workspace bootstrap failed before the agent launched. ` +
    `The orchestrator exhausted its automatic recovery path and needs a valid repo remote or working Git/network access.`
  );
}
