import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { ensureAgentSandboxSchema } from "@/db/ensure-agent-sandbox-schema";
import { dbRead, dbWrite } from "@/db/helpers";
import {
  type AgentPairingToken,
  agentPairingTokens,
  type NewAgentPairingToken,
} from "@/db/schemas/agent-pairing-tokens";

export type { AgentPairingToken, NewAgentPairingToken };

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
