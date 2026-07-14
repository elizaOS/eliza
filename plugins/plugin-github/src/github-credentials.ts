/**
 * Agent-scoped GitHub credentials stored in the shared encrypted vault.
 * The agent identity is part of both the collision-free vault key and the
 * encrypted envelope, so a routing bug cannot silently hand one agent another
 * agent's credential. Missing records are the only disconnected state;
 * storage and validation failures surface to the route boundary.
 */

import { ElizaError } from "@elizaos/core";
import type { Vault } from "@elizaos/vault";

const CREDENTIAL_VERSION = 1;
const VAULT_CALLER = "plugin-github:guided-auth";

export interface GitHubCredentials {
  /** The credential itself. Never sent back to the browser. */
  token: string;
  /** The GitHub `login` returned by `GET api.github.com/user` at save time. */
  username: string;
  /** Scopes GitHub reported when the credential was validated. */
  scopes: string[];
  /** Wall-clock milliseconds when the credential was saved. */
  savedAt: number;
}

/** Subset of {@link GitHubCredentials} safe to return to the browser. */
export type GitHubCredentialMetadata = Omit<GitHubCredentials, "token">;

interface StoredGitHubCredential {
  version: typeof CREDENTIAL_VERSION;
  agentKey: string;
  credentials: GitHubCredentials;
}

export interface GitHubCredentialStore {
  load(agentKey: string): Promise<GitHubCredentials | null>;
  loadMetadata(agentKey: string): Promise<GitHubCredentialMetadata | null>;
  save(agentKey: string, credentials: GitHubCredentials): Promise<void>;
  clear(agentKey: string): Promise<void>;
}

function requireAgentKey(agentKey: string): string {
  const normalized = agentKey.trim();
  if (!normalized) {
    throw new ElizaError("GitHub credential access requires an agent id", {
      code: "GITHUB_AGENT_ID_REQUIRED",
      severity: "fatal",
    });
  }
  return normalized;
}

/**
 * The base64url segment is reversible and collision-free, unlike the lossy
 * punctuation replacement used by generic display-oriented key helpers.
 */
export function githubCredentialVaultKey(agentKey: string): string {
  const encodedAgent = Buffer.from(requireAgentKey(agentKey), "utf8").toString(
    "base64url",
  );
  return `connector.${encodedAgent}.github.guided.oauth.tokens`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCredentials(value: unknown): value is GitHubCredentials {
  if (!isRecord(value)) return false;
  return (
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.username === "string" &&
    value.username.length > 0 &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === "string") &&
    typeof value.savedAt === "number" &&
    Number.isFinite(value.savedAt)
  );
}

function parseStoredCredential(
  raw: string,
  expectedAgentKey: string,
): GitHubCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // error-policy:J2 context-adding rethrow — a present vault entry that is
    // not JSON is corruption, never the legitimate disconnected state.
    throw new ElizaError("Stored GitHub credential is not valid JSON", {
      code: "GITHUB_CREDENTIAL_CORRUPT",
      cause,
      severity: "fatal",
    });
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== CREDENTIAL_VERSION ||
    parsed.agentKey !== expectedAgentKey ||
    !isCredentials(parsed.credentials)
  ) {
    const agentBindingMatches =
      isRecord(parsed) && parsed.agentKey === expectedAgentKey;
    throw new ElizaError("Stored GitHub credential has an invalid envelope", {
      code: "GITHUB_CREDENTIAL_CORRUPT",
      context: { agentBindingMatches },
      severity: "fatal",
    });
  }
  return parsed.credentials;
}

/** Vault-backed implementation shared by all runtimes in a host process. */
export class VaultGitHubCredentialStore implements GitHubCredentialStore {
  constructor(private readonly vault: Vault) {}

  async load(agentKey: string): Promise<GitHubCredentials | null> {
    const normalizedAgentKey = requireAgentKey(agentKey);
    const key = githubCredentialVaultKey(normalizedAgentKey);
    if (!(await this.vault.has(key))) return null;
    const raw = await this.vault.reveal(key, VAULT_CALLER);
    return parseStoredCredential(raw, normalizedAgentKey);
  }

  async loadMetadata(
    agentKey: string,
  ): Promise<GitHubCredentialMetadata | null> {
    const credentials = await this.load(agentKey);
    if (!credentials) return null;
    const { token: _token, ...metadata } = credentials;
    return metadata;
  }

  async save(agentKey: string, credentials: GitHubCredentials): Promise<void> {
    const normalizedAgentKey = requireAgentKey(agentKey);
    if (!isCredentials(credentials)) {
      throw new ElizaError("Refusing to store an invalid GitHub credential", {
        code: "GITHUB_CREDENTIAL_INVALID",
        severity: "fatal",
      });
    }
    const stored: StoredGitHubCredential = {
      version: CREDENTIAL_VERSION,
      agentKey: normalizedAgentKey,
      credentials,
    };
    await this.vault.set(
      githubCredentialVaultKey(normalizedAgentKey),
      JSON.stringify(stored),
      { sensitive: true, caller: VAULT_CALLER },
    );
  }

  async clear(agentKey: string): Promise<void> {
    await this.vault.remove(githubCredentialVaultKey(agentKey));
  }
}

/** Build a credential record from a validated GitHub `/user` response. */
export function buildCredentialsFromUserResponse(
  token: string,
  user: { login: string },
  scopes: string[],
  now: number = Date.now(),
): GitHubCredentials {
  return { token, username: user.login, scopes, savedAt: now };
}
