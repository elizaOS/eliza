/**
 * Resolves repository targets from trusted structured input or explicit
 * repository language without treating arbitrary slash-delimited prose as a
 * clone destination. GitHub identity caching is scoped to a token fingerprint
 * so one hosted tenant can never inherit another tenant's account name.
 */

import { createHash } from "node:crypto";
import { normalizeRepositoryInput } from "./repo-input.js";

const PLACEHOLDER_OWNERS = new Set([
  "yourusername",
  "your-username",
  "your_username",
  "username",
  "youruser",
  "your-user",
  "user",
  "yourorg",
  "your-org",
  "your_org",
  "org",
  "owner",
  "yourname",
  "your-name",
  "example",
  "examples",
  "myusername",
  "my-username",
  "acme",
  "yourhandle",
  "your-handle",
  "placeholder",
]);

const ownerByTokenFingerprint = new Map<string, string>();
const MAX_OWNER_CACHE_ENTRIES = 64;

export interface RepositoryTargetRuntime {
  getSetting?(key: string): unknown;
}

export interface RepositoryTargetOptions {
  runtime: RepositoryTargetRuntime;
  params: Record<string, unknown>;
  requestTexts: ReadonlyArray<string | undefined>;
  fetchImpl?: typeof fetch;
}

function githubToken(runtime: RepositoryTargetRuntime): string | undefined {
  const value = runtime.getSetting?.("GITHUB_TOKEN");
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function tokenOwner(
  runtime: RepositoryTargetRuntime,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const token = githubToken(runtime);
  if (!token) return null;
  const fingerprint = tokenFingerprint(token);
  const cached = ownerByTokenFingerprint.get(fingerprint);
  if (cached) return cached;
  try {
    const response = await fetchImpl("https://api.github.com/user", {
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": "eliza-orchestrator",
      },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { login?: unknown };
    if (typeof body.login !== "string" || !body.login.trim()) return null;
    if (ownerByTokenFingerprint.size >= MAX_OWNER_CACHE_ENTRIES) {
      const oldest = ownerByTokenFingerprint.keys().next().value;
      if (typeof oldest === "string") ownerByTokenFingerprint.delete(oldest);
    }
    ownerByTokenFingerprint.set(fingerprint, body.login);
    return body.login;
  } catch {
    // error-policy:J4 identity lookup is optional only for inferred possessive
    // names; the caller fails that inference closed when no identity is known.
    return null;
  }
}

function githubSlug(repoInput: string): string | null {
  const slug = repoInput
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) ? slug : null;
}

async function repositoryExists(
  runtime: RepositoryTargetRuntime,
  repoInput: string,
  fetchImpl: typeof fetch,
): Promise<boolean | null> {
  const token = githubToken(runtime);
  const slug = githubSlug(repoInput);
  if (!token || !slug) return null;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${slug}`, {
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": "eliza-orchestrator",
      },
    });
    if (response.status === 404) return false;
    return response.ok ? true : null;
  } catch {
    // error-policy:J4 an inferred target is rejected when existence cannot be
    // established; structured inputs still fail loudly at the clone boundary.
    return null;
  }
}

function explicitTextTarget(
  text: string,
): { value: string; kind: "url" | "slug" } | undefined {
  const url = text.match(
    /https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/i,
  );
  if (url) return { value: url[0], kind: "url" };
  const before = text.match(
    /\brepo(?:sitory)?\s+(?:at\s+|is\s+|for\s+)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/i,
  );
  if (before) return { value: before[1], kind: "slug" };
  const after = text.match(
    /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+repo(?:sitory)?\b/i,
  );
  return after?.[1] ? { value: after[1], kind: "slug" } : undefined;
}

/** Resolve a clone target, failing closed for ambiguous prose-derived slugs. */
export async function resolveRequestedRepository(
  options: RepositoryTargetOptions,
): Promise<string | undefined> {
  const { runtime, params } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const text = options.requestTexts.filter(Boolean).join("\n");
  const structured =
    typeof params.repo === "string" && params.repo.trim()
      ? params.repo.trim()
      : undefined;
  const textTarget = explicitTextTarget(text);
  let candidate = structured ?? textTarget?.value;
  const possessiveName = text.match(
    /\bmy\s+([A-Za-z0-9_.-]+)\s+repo(?:sitory)?\b/i,
  )?.[1];

  if (candidate) {
    const slug = githubSlug(normalizeRepositoryInput(candidate));
    const owner = slug?.split("/")[0];
    if (owner && PLACEHOLDER_OWNERS.has(owner.toLowerCase())) {
      candidate = possessiveName ?? slug?.split("/")[1];
    }
  }

  const bare =
    candidate && !candidate.includes("/") ? candidate : possessiveName;
  if (bare && !candidate?.includes("/")) {
    const owner = await tokenOwner(runtime, fetchImpl);
    if (!owner) return undefined;
    candidate = `${owner}/${bare}`;
  }
  if (!candidate) return undefined;

  const normalized = normalizeRepositoryInput(candidate);
  if (structured || textTarget?.kind === "url") return normalized;

  // Prose-derived owner/name targets are routing authority only after the
  // authenticated provider confirms that exact repository exists.
  if ((await repositoryExists(runtime, normalized, fetchImpl)) !== true) {
    if (!possessiveName) return undefined;
    const owner = await tokenOwner(runtime, fetchImpl);
    if (!owner) return undefined;
    const fallback = normalizeRepositoryInput(`${owner}/${possessiveName}`);
    return (await repositoryExists(runtime, fallback, fetchImpl)) === true
      ? fallback
      : undefined;
  }
  return normalized;
}

/** Test-only reset for deterministic cache isolation. */
export function resetRepositoryIdentityCacheForTests(): void {
  ownerByTokenFingerprint.clear();
}
