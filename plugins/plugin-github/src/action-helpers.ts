/**
 * @module action-helpers
 * @description Shared plumbing for GitHub actions: service lookup, identity
 * resolution, parameter extraction, and confirmation gating.
 */

import type { HandlerCallback, IAgentRuntime } from "@elizaos/core";
import {
  type GitHubAccountSelection,
  resolveGitHubAccountSelection,
} from "./accounts.js";
import type { GitHubService } from "./services/github-service.js";
import {
  GITHUB_SERVICE_TYPE,
  type GitHubActionResult,
  type GitHubIdentity,
  type GitHubOctokitClient,
} from "./types.js";

export interface ResolvedClient {
  client: GitHubOctokitClient;
  identity: GitHubIdentity;
  accountId?: string;
}

export function resolveIdentity(
  options: Record<string, unknown> | undefined,
  defaultIdentity: GitHubIdentity,
): GitHubIdentity {
  const raw = options?.as;
  if (raw === "user" || raw === "agent") {
    return raw;
  }
  return defaultIdentity;
}

export function getClient(
  runtime: IAgentRuntime,
  selection: GitHubAccountSelection,
): GitHubOctokitClient | null {
  const service = runtime.getService<GitHubService>(GITHUB_SERVICE_TYPE);
  if (!service) {
    return null;
  }
  return service.getOctokit(selection);
}

export async function reportAndReturn<T>(
  result: GitHubActionResult<T>,
  callback: HandlerCallback | undefined,
  text: string,
): Promise<GitHubActionResult<T>> {
  await callback?.({ text });
  return result;
}

export function requireString(
  options: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const v = options?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function requireNumber(
  options: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const v = options?.[key];
  if (typeof v === "number" && Number.isInteger(v)) {
    return v;
  }
  if (typeof v === "string" && /^\d+$/.test(v)) {
    return Number(v);
  }
  return null;
}

export function requireStringArray(
  options: Record<string, unknown> | undefined,
  key: string,
): string[] | null {
  const v = options?.[key];
  if (!Array.isArray(v)) {
    return null;
  }
  const result: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item.length === 0) {
      return null;
    }
    result.push(item);
  }
  return result;
}

export function optionalStringArray(
  options: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const v = options?.[key];
  if (v === undefined) {
    return undefined;
  }
  return requireStringArray(options, key) ?? undefined;
}

const GITHUB_OWNER_PATTERN = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const RAW_DOT_SEGMENT_PATTERN = /^(?:\.|%2e){1,2}$/i;

function hasRawControlOrBackslash(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\\" || code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Parses a GitHub repository locator into its owner and repository name.
 *
 * Absolute URLs must use HTTP(S), target exactly `github.com`, and omit
 * credentials and non-default ports. WHATWG URL parsing normalizes explicit
 * default ports, so `:80` on HTTP and `:443` on HTTPS remain valid. Alternate
 * hosts are rejected because this plugin's Octokit client has no GHE base URL.
 * Outer whitespace is trimmed, but raw ASCII controls, backslashes, and raw or
 * percent-encoded dot path segments are rejected before WHATWG normalization
 * can retarget the locator. Query and fragment contents are discarded.
 */
export function splitRepo(
  repo: string,
): { owner: string; name: string } | null {
  if (hasRawControlOrBackslash(repo)) {
    return null;
  }

  const cleaned = repo.trim();
  if (!cleaned) {
    return null;
  }

  const isHttpUrl = /^https?:\/\//i.test(cleaned);
  const isBareGitHubUrl = /^github\.com\//i.test(cleaned);
  const hasScheme = /^[A-Za-z][A-Za-z\d+.-]*:/.test(cleaned);
  let path = cleaned;

  if (isHttpUrl || isBareGitHubUrl) {
    const rawUrl = isBareGitHubUrl ? `https://${cleaned}` : cleaned;
    const rawParts = /^https?:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#][\s\S]*)?$/i.exec(
      rawUrl,
    );
    const authority = rawParts?.[1];
    const rawPath = rawParts?.[2] ?? "";
    if (
      !authority ||
      authority.includes("@") ||
      rawPath
        .split("/")
        .some((segment) => RAW_DOT_SEGMENT_PATTERN.test(segment))
    ) {
      return null;
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      // error-policy:J3 Malformed repository URLs remain explicitly invalid.
      return null;
    }

    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname !== "github.com" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== ""
    ) {
      return null;
    }

    path = parsed.pathname;
    if (path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    if (!path.startsWith("/")) {
      return null;
    }
    path = path.slice(1);
  } else if (hasScheme) {
    return null;
  }

  const parts = path.split("/");
  if (parts.length !== 2) {
    return null;
  }

  const owner = parts[0];
  let name = parts[1];
  if (name.endsWith(".git")) {
    name = name.slice(0, -4);
  }

  if (
    !GITHUB_OWNER_PATTERN.test(owner) ||
    !GITHUB_REPO_PATTERN.test(name) ||
    name === "." ||
    name === ".."
  ) {
    return null;
  }

  return { owner, name };
}

/** @deprecated LLM `confirmed` is never authoritative — use {@link requireConfirmation}. */
export function isConfirmed(
  _options: Record<string, unknown> | undefined,
): boolean {
  return false;
}

export function needsClientError(selection: GitHubAccountSelection): string {
  const accountSuffix = selection.accountId
    ? ` accountId "${selection.accountId}"`
    : ` ${selection.role} account`;
  return `GitHub${accountSuffix} token not configured (connect GitHub in Settings → Coding Agents, or set GITHUB_ACCOUNTS or ${
    selection.role === "user" ? "GITHUB_USER_PAT" : "GITHUB_AGENT_PAT"
  })`;
}

export function getServiceOrNull(runtime: IAgentRuntime): GitHubService | null {
  return runtime.getService<GitHubService>(GITHUB_SERVICE_TYPE);
}

export function buildResolvedClient(
  runtime: IAgentRuntime,
  selection: GitHubIdentity | GitHubAccountSelection,
): ResolvedClient | { error: string } {
  if (!getServiceOrNull(runtime)) {
    return { error: "GitHub service not available" };
  }
  const resolvedSelection =
    typeof selection === "string" ? { role: selection } : selection;
  const client = getClient(runtime, resolvedSelection);
  if (!client) {
    return { error: needsClientError(resolvedSelection) };
  }
  return {
    client,
    identity: resolvedSelection.role,
    accountId: resolvedSelection.accountId,
  };
}

export function resolveAccountSelection(
  options: Record<string, unknown> | undefined,
  defaultIdentity: GitHubIdentity,
): GitHubAccountSelection {
  return resolveGitHubAccountSelection(options, defaultIdentity);
}

export function describeSelection(selection: GitHubAccountSelection): string {
  return selection.accountId
    ? `${selection.role} (${selection.accountId})`
    : selection.role;
}
