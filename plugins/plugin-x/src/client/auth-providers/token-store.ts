import type { IAgentRuntime } from "@elizaos/core";
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

export class ConnectorAccountTokenStore implements TokenStore {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly accountId: string,
    private readonly secondaryStore: TokenStore,
  ) {}

  async load(): Promise<StoredOAuth2Tokens | null> {
    const tokenSet = await loadConnectorOAuthTokenSet({
      runtime: this.runtime,
      provider: "x",
      accountId: this.accountId,
      caller: "plugin-x",
    });
    const tokens = normalizeStoredOAuth2Tokens(tokenSet);
    return tokens ?? this.secondaryStore.load();
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
      await this.secondaryStore.save(tokens);
    }
  }

  async clear(): Promise<void> {
    await this.secondaryStore.clear();
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

  throw new Error(
    "Twitter OAuth token persistence requires runtime cache APIs.",
  );
}

function normalizeStoredOAuth2Tokens(
  value: unknown,
): StoredOAuth2Tokens | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const accessToken =
    typeof record.access_token === "string" ? record.access_token : undefined;
  const expiresAt =
    typeof record.expires_at === "number" ? record.expires_at : undefined;
  if (!accessToken || typeof expiresAt !== "number") return null;
  return {
    access_token: accessToken,
    refresh_token:
      typeof record.refresh_token === "string"
        ? record.refresh_token
        : undefined,
    expires_at: expiresAt,
    scope: typeof record.scope === "string" ? record.scope : undefined,
    token_type:
      typeof record.token_type === "string" ? record.token_type : undefined,
  };
}
