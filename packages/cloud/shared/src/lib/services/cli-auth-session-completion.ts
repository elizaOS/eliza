/** Primary-consistent, single-winner persistence for CLI login completion. */

import crypto from "crypto";
import { and, eq, gt } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import { encryptApiKey } from "../../db/crypto/api-keys";
import { type ApiKey, apiKeys, type NewApiKey } from "../../db/schemas/api-keys";
import { type CliAuthSession, cliAuthSessions } from "../../db/schemas/cli-auth-sessions";
import { apiKeysService } from "./api-keys";

interface CompletionState {
  session: CliAuthSession;
  apiKey: ApiKey | undefined;
}

type ClaimResult =
  | {
      claimed: true;
      session: CliAuthSession;
      apiKey: ApiKey;
    }
  | {
      claimed: false;
      session: CliAuthSession | undefined;
      apiKey: ApiKey | undefined;
    };

/**
 * Keeps the CLI-session transition and its API-key insert in one focused
 * consistency boundary. Key encryption happens before the transaction so KMS
 * I/O never holds a database transaction open; a losing candidate remains only
 * in memory and is never persisted.
 */
export class CliAuthSessionCompletionService {
  async findActive(sessionId: string): Promise<CompletionState | undefined> {
    const now = new Date();
    const [session] = await dbWrite
      .select()
      .from(cliAuthSessions)
      .where(and(eq(cliAuthSessions.session_id, sessionId), gt(cliAuthSessions.expires_at, now)))
      .limit(1);

    if (!session) return undefined;

    const [apiKey] = session.api_key_id
      ? await dbWrite.select().from(apiKeys).where(eq(apiKeys.id, session.api_key_id)).limit(1)
      : [];
    return { session, apiKey };
  }

  async claimPending(params: {
    sessionId: string;
    userId: string;
    organizationId: string;
  }): Promise<ClaimResult> {
    const { apiKey } = await this.prepareApiKey(params.userId, params.organizationId);
    const now = new Date();

    return await dbWrite.transaction(async (tx) => {
      const [claimedSession] = await tx
        .update(cliAuthSessions)
        .set({
          status: "authenticated",
          user_id: params.userId,
          api_key_id: apiKey.id,
          authenticated_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(cliAuthSessions.session_id, params.sessionId),
            eq(cliAuthSessions.status, "pending"),
            gt(cliAuthSessions.expires_at, now),
          ),
        )
        .returning();

      if (!claimedSession) {
        const [currentSession] = await tx
          .select()
          .from(cliAuthSessions)
          .where(eq(cliAuthSessions.session_id, params.sessionId))
          .limit(1);
        const [currentApiKey] = currentSession?.api_key_id
          ? await tx
              .select()
              .from(apiKeys)
              .where(eq(apiKeys.id, currentSession.api_key_id))
              .limit(1)
          : [];
        return {
          claimed: false,
          session: currentSession,
          apiKey: currentApiKey,
        };
      }

      const [createdKey] = await tx.insert(apiKeys).values(apiKey).returning();
      if (!createdKey) throw new Error("Failed to create CLI API key");

      return {
        claimed: true,
        session: claimedSession,
        apiKey: createdKey,
      };
    });
  }

  private async prepareApiKey(
    userId: string,
    organizationId: string,
  ): Promise<{ apiKey: NewApiKey }> {
    const { key, hash, prefix } = apiKeysService.generateApiKey();
    const id = crypto.randomUUID();
    const encrypted = await encryptApiKey(organizationId, id, key);

    return {
      apiKey: {
        id,
        name: `CLI Login - ${new Date().toISOString()}`,
        description: "Generated via CLI login command",
        organization_id: organizationId,
        user_id: userId,
        rate_limit: 1000,
        is_active: true,
        expires_at: null,
        key_hash: hash,
        key_prefix: prefix,
        key_ciphertext: encrypted.ciphertext,
        key_nonce: encrypted.nonce,
        key_auth_tag: encrypted.auth_tag,
        key_kms_key_id: encrypted.kms_key_id,
        key_kms_key_version: encrypted.kms_key_version,
      },
    };
  }
}

export const cliAuthSessionCompletionService = new CliAuthSessionCompletionService();
