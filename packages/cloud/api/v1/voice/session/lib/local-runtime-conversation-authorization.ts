const MAX_VOICE_TOKEN_LIFETIME_MS = 120_000;
const DEFAULT_MAX_AUTHORIZED_CONVERSATIONS = 32;

export interface LocalRuntimeConversationAuthorization {
  authorize(
    conversationId: string,
  ): Promise<LocalRuntimeConversationAuthorizationResult>;
  isAuthorized(conversationId: string): boolean;
  revoke(conversationId: string): void;
}

export interface LocalRuntimeConversationAuthorizationOptions {
  validate(
    conversationId: string,
  ): Promise<LocalRuntimeConversationAuthorizationResult>;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export type LocalRuntimeConversationAuthorizationResult =
  | "authorized"
  | "forbidden";

/**
 * Revalidates every mint against the live runtime, then grants the downstream
 * stream bridge a short authorization lease. Leases never outlive the voice
 * token ceiling and the bounded map prevents rapid conversation churn from
 * growing process memory without limit.
 */
export function createLocalRuntimeConversationAuthorization(
  options: LocalRuntimeConversationAuthorizationOptions,
): LocalRuntimeConversationAuthorization {
  const ttlMs = options.ttlMs ?? MAX_VOICE_TOKEN_LIFETIME_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_AUTHORIZED_CONVERSATIONS;
  if (
    !Number.isInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > MAX_VOICE_TOKEN_LIFETIME_MS
  ) {
    throw new Error("local voice conversation authorization TTL is invalid");
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 128) {
    throw new Error("local voice conversation authorization limit is invalid");
  }

  const now = options.now ?? Date.now;
  const grants = new Map<string, number>();

  const prune = (currentTime: number): void => {
    for (const [conversationId, expiresAt] of grants) {
      if (expiresAt <= currentTime) grants.delete(conversationId);
    }
  };

  const revoke = (conversationId: string): void => {
    grants.delete(conversationId);
  };

  return {
    async authorize(
      conversationId,
    ): Promise<LocalRuntimeConversationAuthorizationResult> {
      prune(now());
      let result: LocalRuntimeConversationAuthorizationResult;
      try {
        result = await options.validate(conversationId);
      } catch (error) {
        revoke(conversationId);
        throw error;
      }
      if (result !== "authorized") {
        revoke(conversationId);
        return "forbidden";
      }

      const grantedAt = now();
      prune(grantedAt);
      grants.delete(conversationId);
      while (grants.size >= maxEntries) {
        const oldestConversationId = grants.keys().next().value;
        if (oldestConversationId === undefined) break;
        grants.delete(oldestConversationId);
      }
      grants.set(conversationId, grantedAt + ttlMs);
      return "authorized";
    },
    isAuthorized(conversationId): boolean {
      const currentTime = now();
      prune(currentTime);
      return (grants.get(conversationId) ?? 0) > currentTime;
    },
    revoke,
  };
}
