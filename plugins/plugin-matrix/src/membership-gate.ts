/**
 * Membership admission gate for inbound Matrix room messages: consults the
 * canonical membership authority, reconciles against the SDK's live joined
 * roster on evidence-miss denials (backfill for never-seen members), and
 * fails closed when the authority cannot produce fresh evidence. Direct
 * rooms (two joined members) are not membership-governed — a DM is
 * inherently addressed — and bypass the gate.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import type { MatrixMembershipAuthority } from "./membership";
import { matrixMembershipShouldReconcile, resolveMembershipService } from "./membership";

const CONNECTOR_ACCOUNT_PROVIDER = "matrix";

/**
 * Durable connector-account bootstrap: upserts the (agent, "matrix",
 * <account>) row through the ConnectorAccountManager so the membership
 * authority's connector-account FK resolves to a stable UUID.
 */
export async function bootstrapMatrixMembershipAccount(input: {
  runtime: IAgentRuntime;
  /** Normalized Matrix account id (DEFAULT_MATRIX_ACCOUNT_ID for the default). */
  matrixAccountId: string;
  /** Full Matrix user id for this account (@bot:server). */
  matrixUserId: string;
  /** Personal (OWNER) accounts act as the user; the default bot is AGENT. */
  personal: boolean;
}): Promise<UUID | null> {
  try {
    const { getConnectorAccountManager } = await import("@elizaos/core");
    const manager = getConnectorAccountManager(input.runtime);
    const now = Date.now();
    const account = {
      id: `matrix-${input.matrixAccountId}`,
      provider: CONNECTOR_ACCOUNT_PROVIDER,
      label: `Matrix account ${input.matrixUserId}`,
      role: input.personal ? ("OWNER" as const) : ("AGENT" as const),
      purpose: ["messaging"],
      accessGate: input.personal ? ("owner_binding" as const) : ("open" as const),
      status: "connected" as const,
      externalId: input.matrixUserId,
      createdAt: now,
      updatedAt: now,
    };
    const stored = await manager.upsertAccount(CONNECTOR_ACCOUNT_PROVIDER, account);
    if (!stored.id || !isUuidLike(stored.id)) {
      // The authority service IS configured, but its connector-account store
      // returned a malformed result. This must NOT degrade to the
      // absent-authority legacy allow mode: throw so the caller marks the
      // admission gate broken and every room admission fails closed.
      throw new ElizaError("Matrix membership bootstrap received a non-UUID connector account id", {
        code: "MATRIX_MEMBERSHIP_BOOTSTRAP_INVALID_ACCOUNT",
        context: {
          matrixAccountId: input.matrixAccountId,
          storedId: stored.id ?? null,
        },
      });
    }
    return stored.id as UUID;
  } catch (error) {
    // error-policy:J2 Bootstrap failure must stay distinguishable from an
    // absent connector-account manager: wrap and rethrow so the service
    // records a BROKEN gate (fail-closed room admission) instead of silently
    // degrading to the absent-authority legacy allow mode.
    throw new ElizaError("Matrix membership connector-account bootstrap failed", {
      code: "MATRIX_MEMBERSHIP_BOOTSTRAP_FAILED",
      cause: error,
    });
  }
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export interface MatrixMembershipGate {
  authority: MatrixMembershipAuthority;
  connectorAccountId: UUID;
}

/**
 * Builds the per-account membership gate, or null when the authority service
 * is absent (deployments without plugin-sql keep the legacy ungated mode with
 * a once-per-room warning; MATRIX_MEMBERSHIP_ENFORCE=1 opts into strict
 * fail-closed).
 */
export async function createMatrixMembershipGate(input: {
  runtime: IAgentRuntime;
  matrixAccountId: string;
  matrixUserId: string;
  personal: boolean;
}): Promise<MatrixMembershipGate | null> {
  const service = resolveMembershipService(input.runtime);
  if (!service) {
    return null;
  }
  const connectorAccountId = await bootstrapMatrixMembershipAccount({
    runtime: input.runtime,
    matrixAccountId: input.matrixAccountId,
    matrixUserId: input.matrixUserId,
    personal: input.personal,
  });
  if (!connectorAccountId) {
    return null;
  }
  const { MatrixMembershipAuthority: Authority } = await import("./membership");
  return {
    authority: new Authority({
      runtime: input.runtime,
      connectorAccountId,
      service,
    }),
    connectorAccountId,
  };
}

/** Decision input for one inbound message's membership admission. */
export interface MatrixMembershipGateDecisionInput {
  roomId: string;
  /** True for direct rooms (bypass — DMs are not membership-governed). */
  isDirectRoom: boolean;
  principalEntityId: UUID;
  matrixUserId: string;
  /** Live joined roster straight from the SDK state, for reconcile. */
  getJoinedMemberIds: () => string[];
}

export class MatrixMembershipMessageGate {
  private readonly runtime: IAgentRuntime;
  private authority: MatrixMembershipAuthority | null;
  private broken = false;
  private readonly warned = new Set<string>();

  constructor(input: {
    runtime: IAgentRuntime;
    authority: MatrixMembershipAuthority | null;
  }) {
    this.runtime = input.runtime;
    this.authority = input.authority;
  }

  /** Marks the gate broken: authority bootstrap failed while configured. */
  markBroken(): void {
    this.broken = true;
    this.authority = null;
    this.warned.clear();
  }

  /** True when the message may proceed to agent dispatch. */
  async authorizeMessage(input: MatrixMembershipGateDecisionInput): Promise<boolean> {
    // A BROKEN gate fails closed for EVERY room, direct rooms included: a
    // configured authority that failed bootstrap must never be bypassed by
    // room shape. (The absent-authority legacy mode below still allows DMs.)
    if (this.broken) {
      this.warnOnce(
        `authority-broken:${input.roomId}`,
        "Matrix room admission denied: membership authority is unavailable",
        { roomId: input.roomId }
      );
      return false;
    }
    if (input.isDirectRoom) {
      return true;
    }
    if (!this.authority && process.env.MATRIX_MEMBERSHIP_ENFORCE === "1") {
      this.warnOnce(
        `authority-broken:${input.roomId}`,
        "Matrix room admission denied: membership authority is unavailable",
        { roomId: input.roomId }
      );
      return false;
    }
    if (!this.authority) {
      // The membership authority service was never registered (deployment
      // without plugin-sql): admission degrades to allow with a once-per-room
      // structured warning. MATRIX_MEMBERSHIP_ENFORCE opts into strict
      // fail-closed. When the service IS present but scope evidence is stale
      // or unavailable, the deny path below still fails closed.
      this.warnOnce(
        `authority-absent:${input.roomId}`,
        "Matrix room admission running without a membership authority service; membership checks disabled",
        { roomId: input.roomId }
      );
      return true;
    }
    const decision = await this.authority.authorize({
      roomId: input.roomId,
      canonicalPrincipalId: input.principalEntityId,
    });
    if (decision.decision === "allowed") {
      return true;
    }
    if (matrixMembershipShouldReconcile(decision)) {
      // Reconcile against the SDK's live joined roster (m.room.member state is
      // unencrypted, so this works in E2EE rooms too).
      const joined = input.getJoinedMemberIds();
      if (joined.includes(input.matrixUserId)) {
        await this.authority.recordTransitionFromRoster({
          roomId: input.roomId,
          matrixUserId: input.matrixUserId,
          canonicalPrincipalId: input.principalEntityId,
        });
        const recheck = await this.authority.authorize({
          roomId: input.roomId,
          canonicalPrincipalId: input.principalEntityId,
        });
        if (recheck.decision === "allowed") {
          return true;
        }
        this.logDenial(input, recheck.reason, "post-reconcile");
        return false;
      }
      this.logDenial(input, decision.reason, "roster-miss");
      return false;
    }
    this.logDenial(input, decision.reason, "authority");
    return false;
  }

  private logDenial(input: MatrixMembershipGateDecisionInput, reason: string, stage: string): void {
    logger.warn(
      {
        src: "plugin:matrix",
        agentId: this.runtime.agentId,
        roomId: input.roomId,
        matrixUserId: input.matrixUserId,
        reason,
        stage,
      },
      "Matrix room message denied by membership authority"
    );
  }

  private warnOnce(key: string, message: string, context: unknown): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logger.warn(
      {
        src: "plugin:matrix",
        agentId: this.runtime.agentId,
        ...(context as { roomId?: string }),
      },
      message
    );
  }
}
