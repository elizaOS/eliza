/**
 * Persists one-time agent pairing tokens and performs their atomic,
 * identity-bound consumption through the shared database boundary.
 */
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { ensureAgentSandboxSchema } from "../ensure-agent-sandbox-schema";
import { dbRead, dbWrite, writeTransaction } from "../helpers";
import {
  type AgentPairingToken,
  agentPairingTokens,
  type NewAgentPairingToken,
} from "../schemas/agent-pairing-tokens";
import { agentSandboxes } from "../schemas/agent-sandboxes";

export type { AgentPairingToken, NewAgentPairingToken };

export interface BrowserPairingTokenBinding {
  agentId: string;
  expectedOrigin: string;
}

export type BrowserPairingTokenClaim =
  | {
      status: "claimed";
      token: AgentPairingToken;
      apiKey: string;
      agentName: string | null;
    }
  | { status: "invalid" }
  | { status: "sandbox-credential-unavailable" };

export interface AuthenticatedPairingTokenBinding {
  userId: string;
  organizationId: string;
  agentId: string;
  expectedOrigin: string;
}

export type AuthenticatedPairingTokenClaim =
  | {
      status: "claimed";
      token: AgentPairingToken;
      apiKey: string;
      agentName: string | null;
    }
  | { status: "invalid" }
  | { status: "sandbox-credential-unavailable" };

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
   * Claim a browser pairing token and its sandbox credential from one locked
   * database snapshot. Both the URL-selected agent and the public origin are
   * bound before the token can be consumed, and a broken sandbox credential
   * leaves the one-time token available for a later valid retry.
   */
  async consumeValidBrowserToken(
    tokenHash: string,
    binding: BrowserPairingTokenBinding,
  ): Promise<BrowserPairingTokenClaim> {
    await ensureAgentSandboxSchema();

    return writeTransaction(async (tx) => {
      const observedAt = new Date();
      const [token] = await tx
        .select()
        .from(agentPairingTokens)
        .where(
          and(
            eq(agentPairingTokens.token_hash, tokenHash),
            eq(agentPairingTokens.agent_id, binding.agentId),
            eq(agentPairingTokens.expected_origin, binding.expectedOrigin),
            isNull(agentPairingTokens.used_at),
            gt(agentPairingTokens.expires_at, observedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!token) return { status: "invalid" };

      const [sandbox] = await tx
        .select({
          agentName: agentSandboxes.agent_name,
          environmentVars: agentSandboxes.environment_vars,
        })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, binding.agentId),
            eq(agentSandboxes.organization_id, token.organization_id),
          ),
        )
        .limit(1)
        .for("update");
      if (!sandbox) return { status: "invalid" };

      const rawApiKey = sandbox.environmentVars?.ELIZA_API_TOKEN;
      if (typeof rawApiKey !== "string" || rawApiKey.trim().length === 0) {
        return { status: "sandbox-credential-unavailable" };
      }

      const claimedAt = new Date();
      const [claimedToken] = await tx
        .update(agentPairingTokens)
        .set({ used_at: claimedAt })
        .where(
          and(
            eq(agentPairingTokens.id, token.id),
            eq(agentPairingTokens.agent_id, binding.agentId),
            eq(agentPairingTokens.expected_origin, binding.expectedOrigin),
            isNull(agentPairingTokens.used_at),
            gt(agentPairingTokens.expires_at, claimedAt),
          ),
        )
        .returning();
      if (!claimedToken) return { status: "invalid" };

      return {
        status: "claimed",
        token: claimedToken,
        apiKey: rawApiKey,
        agentName: sandbox.agentName,
      };
    });
  }

  /**
   * Claim a native pairing token and the matching sandbox credential from one
   * locked database snapshot. Locking both rows closes the ownership-transfer
   * and credential-rotation gap between checking the sandbox and consuming the
   * token, while leaving a token unused when its sandbox credential is broken.
   */
  async consumeValidAuthenticatedToken(
    tokenHash: string,
    binding: AuthenticatedPairingTokenBinding,
  ): Promise<AuthenticatedPairingTokenClaim> {
    await ensureAgentSandboxSchema();

    return writeTransaction(async (tx) => {
      const observedAt = new Date();
      const [token] = await tx
        .select()
        .from(agentPairingTokens)
        .where(
          and(
            eq(agentPairingTokens.token_hash, tokenHash),
            eq(agentPairingTokens.user_id, binding.userId),
            eq(agentPairingTokens.organization_id, binding.organizationId),
            eq(agentPairingTokens.agent_id, binding.agentId),
            eq(agentPairingTokens.expected_origin, binding.expectedOrigin),
            isNull(agentPairingTokens.used_at),
            gt(agentPairingTokens.expires_at, observedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!token) return { status: "invalid" };

      const [sandbox] = await tx
        .select({
          agentName: agentSandboxes.agent_name,
          environmentVars: agentSandboxes.environment_vars,
        })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, binding.agentId),
            eq(agentSandboxes.organization_id, binding.organizationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!sandbox) return { status: "invalid" };

      const rawApiKey = sandbox.environmentVars?.ELIZA_API_TOKEN;
      const apiKey = typeof rawApiKey === "string" ? rawApiKey.trim() : "";
      if (!apiKey) {
        return { status: "sandbox-credential-unavailable" };
      }

      const claimedAt = new Date();
      const [claimedToken] = await tx
        .update(agentPairingTokens)
        .set({ used_at: claimedAt })
        .where(
          and(
            eq(agentPairingTokens.id, token.id),
            isNull(agentPairingTokens.used_at),
            gt(agentPairingTokens.expires_at, claimedAt),
          ),
        )
        .returning();
      if (!claimedToken) return { status: "invalid" };

      return {
        status: "claimed",
        token: claimedToken,
        apiKey,
        agentName: sandbox.agentName,
      };
    });
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
