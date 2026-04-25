/**
 * @module action-helpers
 * @description Shared plumbing for GitHub actions: service lookup, identity
 * resolution, parameter extraction, and confirmation gating.
 */

import type { HandlerCallback, IAgentRuntime } from "@elizaos/core";
import type { Octokit } from "@octokit/rest";
import type { GitHubService } from "./services/github-service.js";
import {
  GITHUB_SERVICE_TYPE,
  type GitHubActionResult,
  type GitHubIdentity,
} from "./types.js";

export interface ResolvedClient {
  client: Octokit;
  identity: GitHubIdentity;
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
  identity: GitHubIdentity,
): Octokit | null {
  const service = runtime.getService<GitHubService>(GITHUB_SERVICE_TYPE);
  if (!service) {
    return null;
  }
  return service.getOctokit(identity);
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

export function needsClientError(identity: GitHubIdentity): string {
  return `GitHub ${identity} token not configured (set ${
    identity === "user" ? "GITHUB_USER_PAT" : "GITHUB_AGENT_PAT"
  })`;
}

export function getServiceOrNull(runtime: IAgentRuntime): GitHubService | null {
  return runtime.getService<GitHubService>(GITHUB_SERVICE_TYPE);
}

export function buildResolvedClient(
  runtime: IAgentRuntime,
  identity: GitHubIdentity,
): ResolvedClient | { error: string } {
  if (!getServiceOrNull(runtime)) {
    return { error: "GitHub service not available" };
  }
  const client = getClient(runtime, identity);
  if (!client) {
    return { error: needsClientError(identity) };
  }
  return { client, identity };
}
