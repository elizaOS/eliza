/**
 * Persists one-time agent pairing tokens and performs their atomic,
 * identity-bound consumption through the shared database boundary.
 */
import { and, eq, exists, gt, isNull, lt } from "drizzle-orm";
import { ensureAgentSandboxSchema } from "../ensure-agent-sandbox-schema";
import { dbRead, dbWrite } from "../helpers";
import {
  type AgentPairingToken,
  agentPairingTokens,
  type NewAgentPairingToken,
} from "../schemas/agent-pairing-tokens";
import { agentSandboxes } from "../schemas/agent-sandboxes";

export type { AgentPairingToken, NewAgentPairingToken };

export interface AuthenticatedPairingTokenBinding {
  userId: string;
  organizationId: string;
  agentId: string;
  expectedOrigin: string;
}

export class AgentPairingTokensRepository {
  async create(data: NewAgentPairingToken): Promise<AgentPairingToken> {
    await ensureAgentSandboxSchema();

    const [row] = await dbWrite.insert(agentPairingTokens).values(data).returning();

    if (!row) {
      throw new Error("Failed to create pairing token");
    }

    return row;
  }

  async consumeValidToken(
    tokenHash: string,
    expectedOrigin: string,
  ): Promise<AgentPairingToken | undefined> {
    await ensureAgentSandboxSchema();

    const now = new Date();

    const [row] = await dbWrite
      .update(agentPairingTokens)
      .set({ used_at: now })
      .where(
        and(
          eq(agentPairingTokens.token_hash, tokenHash),
          eq(agentPairingTokens.expected_origin, expectedOrigin),
          isNull(agentPairingTokens.used_at),
          gt(agentPairingTokens.expires_at, now),
        ),
      )
      .returning();

    return row;
  }

  /**
   * Atomically consume a native pairing token only when every authenticated
   * binding still matches. Keeping identity, tenant, agent, origin, expiry,
   * and single-use checks in one UPDATE prevents a failed cross-tenant or
   * wrong-origin attempt from burning the rightful owner's token.
   */
  async consumeValidAuthenticatedToken(
    tokenHash: string,
    binding: AuthenticatedPairingTokenBinding,
  ): Promise<AgentPairingToken | undefined> {
    await ensureAgentSandboxSchema();

    const now = new Date();

    const [row] = await dbWrite
      .update(agentPairingTokens)
      .set({ used_at: now })
      .where(
        and(
          eq(agentPairingTokens.token_hash, tokenHash),
          eq(agentPairingTokens.user_id, binding.userId),
          eq(agentPairingTokens.organization_id, binding.organizationId),
          eq(agentPairingTokens.agent_id, binding.agentId),
          eq(agentPairingTokens.expected_origin, binding.expectedOrigin),
          isNull(agentPairingTokens.used_at),
          gt(agentPairingTokens.expires_at, now),
          exists(
            dbWrite
              .select({ id: agentSandboxes.id })
              .from(agentSandboxes)
              .where(
                and(
                  eq(agentSandboxes.id, binding.agentId),
                  eq(agentSandboxes.organization_id, binding.organizationId),
                ),
              ),
          ),
        ),
      )
      .returning();

    return row;
  }

  async deleteExpired(): Promise<number> {
    await ensureAgentSandboxSchema();

    const now = new Date();
    const deleted = await dbWrite
      .delete(agentPairingTokens)
      .where(and(lt(agentPairingTokens.expires_at, now), isNull(agentPairingTokens.used_at)))
      .returning({ id: agentPairingTokens.id });

    return deleted.length;
  }

  async findByTokenHash(tokenHash: string): Promise<AgentPairingToken | undefined> {
    await ensureAgentSandboxSchema();

    const [row] = await dbRead
      .select()
      .from(agentPairingTokens)
      .where(eq(agentPairingTokens.token_hash, tokenHash))
      .limit(1);

    return row;
  }
}

export const agentPairingTokensRepository = new AgentPairingTokensRepository();
