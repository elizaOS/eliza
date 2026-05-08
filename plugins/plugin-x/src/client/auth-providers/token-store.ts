import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  loadConnectorOAuthTokenSet,
  saveConnectorOAuthTokenSet,
} from "../../connector-credential-refs";
import { DEFAULT_X_ACCOUNT_ID, normalizeXAccountId } from "../accounts";

export interface StoredOAuth2Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  scope?: string;
  token_type?: string;
}

export interface TokenStore {
  load(): Promise<StoredOAuth2Tokens | null>;
  save(tokens: StoredOAuth2Tokens): Promise<void>;
  clear(): Promise<void>;
}

export class RuntimeCacheTokenStore implements TokenStore {
  private readonly key: string;
  constructor(
    private readonly runtime: IAgentRuntime,
    accountId: string = DEFAULT_X_ACCOUNT_ID,
    key?: string,
  ) {
    this.key =
      key ??
      `twitter/oauth2/tokens/${runtime.agentId}/${normalizeXAccountId(accountId)}`;
  }

  async load(): Promise<StoredOAuth2Tokens | null> {
    try {
      const v = await this.runtime.getCache<StoredOAuth2Tokens>(this.key);
      return v ?? null;
    } catch {
      return null;
    }
  }

  async save(tokens: StoredOAuth2Tokens): Promise<void> {
    await this.runtime.setCache(this.key, tokens);
  }

  async clear(): Promise<void> {
    // Prefer deleting semantics without relying on null (some runtimes/types
    // disallow null). If the runtime doesn't support true deletion, setting
    // `undefined` should be treated as "not set". The runtime cache typing
    // requires a defined value, but every real implementation accepts
    // `undefined` as a tombstone.
    await this.runtime.setCache(
      this.key,
      undefined as unknown as StoredOAuth2Tokens,
    );
  }
}

export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  static defaultPath(accountId: string = DEFAULT_X_ACCOUNT_ID): string {
    // Explicit warning is logged by the provider when this fallback is used.
    return join(
      homedir(),
      ".eliza",
      "twitter",
      "accounts",
      normalizeXAccountId(accountId),
      "oauth2.tokens.json",
    );
  }

  async load(): Promise<StoredOAuth2Tokens | null> {
    try {
      const raw = await fs.readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.access_token !== "string") return null;
      if (typeof parsed.expires_at !== "number") return null;
      return parsed as StoredOAuth2Tokens;
    } catch {
      return null;
    }
  }

  async save(tokens: StoredOAuth2Tokens): Promise<void> {
    // Ensure token directory + file are owner-only (defense-in-depth for shared machines).
    await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.path, JSON.stringify(tokens, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    // Some platforms ignore mode on write when file already exists; enforce explicitly.
    try {
      await fs.chmod(this.path, 0o600);
    } catch {
      // ignore
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.path);
    } catch {
      // ignore
    }
  }
}

export class ConnectorAccountTokenStore implements TokenStore {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly accountId: string,
    private readonly fallback: TokenStore,
  ) {}

  async load(): Promise<StoredOAuth2Tokens | null> {
    const tokenSet = await loadConnectorOAuthTokenSet({
      runtime: this.runtime,
      provider: "x",
      accountId: this.accountId,
      caller: "plugin-x",
    });
    const tokens = normalizeStoredOAuth2Tokens(tokenSet);
    return tokens ?? this.fallback.load();
  }

  async save(tokens: StoredOAuth2Tokens): Promise<void> {
    const saved = await saveConnectorOAuthTokenSet({
      runtime: this.runtime,
      provider: "x",
      accountId: this.accountId,
      value: JSON.stringify(tokens),
      expiresAt: tokens.expires_at,
      caller: "plugin-x",
    });
    if (!saved) {
      await this.fallback.save(tokens);
    }
  }

  async clear(): Promise<void> {
    await this.fallback.clear();
  }
}

export function chooseDefaultTokenStore(
  runtime: IAgentRuntime | undefined,
  accountId: string = DEFAULT_X_ACCOUNT_ID,
): TokenStore {
  const normalizedAccountId = normalizeXAccountId(accountId);
  if (
    runtime &&
    typeof runtime.getCache === "function" &&
    typeof runtime.setCache === "function"
  ) {
    return new ConnectorAccountTokenStore(
      runtime,
      normalizedAccountId,
      new RuntimeCacheTokenStore(runtime, normalizedAccountId),
    );
  }

  logger.warn(
    "Twitter OAuth token persistence: runtime cache API not available; falling back to local token file. " +
      "This file contains sensitive tokens—protect it and rotate tokens if compromised.",
  );
  const fallback = new FileTokenStore(FileTokenStore.defaultPath(normalizedAccountId));
  return runtime
    ? new ConnectorAccountTokenStore(runtime, normalizedAccountId, fallback)
    : fallback;
}

function normalizeStoredOAuth2Tokens(value: unknown): StoredOAuth2Tokens | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const accessToken = typeof record.access_token === "string" ? record.access_token : undefined;
  const expiresAt = typeof record.expires_at === "number" ? record.expires_at : undefined;
  if (!accessToken || typeof expiresAt !== "number") return null;
  return {
    access_token: accessToken,
    refresh_token:
      typeof record.refresh_token === "string" ? record.refresh_token : undefined,
    expires_at: expiresAt,
    scope: typeof record.scope === "string" ? record.scope : undefined,
    token_type: typeof record.token_type === "string" ? record.token_type : undefined,
  };
}
