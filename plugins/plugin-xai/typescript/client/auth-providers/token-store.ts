import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

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
    key?: string
  ) {
    this.key = key ?? `x/oauth2/tokens/${runtime.agentId}`;
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
    // Use deleteCache for proper deletion semantics
    await this.runtime.deleteCache(this.key);
  }
}

export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  static defaultPath(): string {
    // Explicit warning is logged by the provider when this fallback is used.
    return join(homedir(), ".eliza", "x", "oauth2.tokens.json");
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

export function chooseDefaultTokenStore(runtime: IAgentRuntime | undefined): TokenStore {
  if (runtime && typeof runtime.getCache === "function" && typeof runtime.setCache === "function") {
    return new RuntimeCacheTokenStore(runtime);
  }

  logger.warn(
    "X OAuth token persistence: runtime cache API not available; falling back to local token file. " +
      "This file contains sensitive tokens—protect it and rotate tokens if compromised."
  );
  return new FileTokenStore(FileTokenStore.defaultPath());
}
