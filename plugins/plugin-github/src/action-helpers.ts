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

/** Splits "owner/repo" into its two components. Returns null on malformed input. */
export function splitRepo(
  repo: string,
): { owner: string; name: string } | null {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { owner: parts[0], name: parts[1] };
}

export function isConfirmed(
  options: Record<string, unknown> | undefined,
): boolean {
  return options?.confirmed === true;
}

export function needsClientError(selection: GitHubAccountSelection): string {
  const accountSuffix = selection.accountId
    ? ` accountId "${selection.accountId}"`
    : ` ${selection.role} account`;
  return `GitHub${accountSuffix} token not configured (set GITHUB_ACCOUNTS or ${
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
