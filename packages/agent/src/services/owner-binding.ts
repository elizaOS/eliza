/**
 * Backend authority for the connector owner-pairing flow: registers the
 * `OWNER_BIND_VERIFY` service that plugin-discord's `/eliza-pair` and
 * plugin-telegram's `/eliza_pair` commands relay codes to. The connectors are
 * pure relays (they never decide whether a binding succeeds); this service owns
 * the one-time pair codes and, on a successful verification, writes the proven
 * platform identity into the canonical owner entity's metadata. Role resolution
 * then recognizes the paired platform user as OWNER through core's
 * `connectorIdentityMatches` path (`packages/core/src/roles.ts`,
 * resolveOwnershipRole) — no core change and no per-connector special case.
 *
 * Security invariants:
 *   - A code can only be issued while a canonical owner is configured
 *     (`ELIZA_ADMIN_ENTITY_ID` / owner contacts); with no configured owner,
 *     "the app owner" is undefined and pairing would be a promotion vector.
 *   - Codes are 6 crypto-random digits, hashed at rest, single-use, expire
 *     after 5 minutes, and allow 5 verification attempts before invalidation.
 *   - Comparison is constant-time; failures return typed error strings and
 *     never leak whether a pending code exists for another connector.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import {
  ElizaError,
  getConfiguredOwnerEntityIds,
  type IAgentRuntime,
  logger,
  Service,
  type UUID,
} from "@elizaos/core";

/** Service registry key the connector pairing services look up. */
export const OWNER_BIND_VERIFY_SERVICE = "OWNER_BIND_VERIFY";

/** Connectors the pairing relays support (mirrors the connector-side union). */
export const OWNER_BIND_CONNECTORS = [
  "discord",
  "telegram",
  "wechat",
  "matrix",
] as const;

export type OwnerBindConnector = (typeof OWNER_BIND_CONNECTORS)[number];

/** Pair codes expire after this window. */
export const OWNER_BIND_CODE_TTL_MS = 5 * 60_000;
/** Verification attempts allowed per issued code before it is invalidated. */
export const OWNER_BIND_MAX_ATTEMPTS = 5;

export interface OwnerBindVerifyParams {
  connector: OwnerBindConnector;
  /** Stable platform user id (Discord snowflake, Telegram numeric id, …). */
  externalId: string;
  /** Human-readable handle for logs and the owner entity's display fields. */
  displayHandle: string;
  code: string;
}

export interface OwnerBindVerifyResult {
  success: boolean;
  error?: string;
}

export interface OwnerBindIssueResult {
  connector: OwnerBindConnector;
  /** The one-time 6-digit code — shown to the owner exactly once. */
  code: string;
  expiresAt: number;
}

type PendingBind = {
  connector: OwnerBindConnector;
  codeHash: Buffer;
  expiresAt: number;
  attemptsRemaining: number;
  /** Owner entity captured at issuance so verify binds to the same identity
   *  even if settings change mid-flow. */
  ownerEntityId: UUID;
};

function hashCode(code: string): Buffer {
  return createHash("sha256").update(code, "utf8").digest();
}

function isSupportedConnector(value: unknown): value is OwnerBindConnector {
  return (
    typeof value === "string" &&
    (OWNER_BIND_CONNECTORS as readonly string[]).includes(value)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class OwnerBindingService extends Service {
  static override serviceType = OWNER_BIND_VERIFY_SERVICE;

  override capabilityDescription =
    "Issues and verifies one-time owner pairing codes so a connector user " +
    "(Discord/Telegram/…) can be proven to be the app owner; successful " +
    "verification binds the platform identity to the canonical owner entity";

  // Pending codes are process-local on purpose: a restart voids outstanding
  // codes (the owner just requests a new one), which is strictly safer than
  // persisting secrets, and the 5-minute TTL makes loss inconsequential.
  private readonly pending = new Map<OwnerBindConnector, PendingBind>();
  private readonly now: () => number;

  constructor(runtime: IAgentRuntime, now: () => number = Date.now) {
    super(runtime);
    this.now = now;
  }

  static async start(runtime: IAgentRuntime): Promise<OwnerBindingService> {
    logger.info(
      { src: "agent:owner-binding", agentId: runtime.agentId },
      "OwnerBindingService started (OWNER_BIND_VERIFY registered)",
    );
    return new OwnerBindingService(runtime);
  }

  async stop(): Promise<void> {
    this.pending.clear();
  }

  /**
   * Issue a one-time pair code for `connector`, replacing any code previously
   * pending for it. Throws when no canonical owner is configured — pairing
   * binds a platform identity TO the owner, so without a configured owner
   * there is nothing safe to bind to.
   */
  beginOwnerBind(params: {
    connector: OwnerBindConnector;
  }): OwnerBindIssueResult {
    if (!isSupportedConnector(params.connector)) {
      throw new ElizaError("Unsupported owner-pairing connector", {
        code: "OWNER_BIND_UNSUPPORTED_CONNECTOR",
        context: { connector: String(params.connector) },
      });
    }

    const ownerIds = getConfiguredOwnerEntityIds(this.runtime);
    const ownerEntityId = ownerIds[0];
    if (!ownerEntityId) {
      throw new ElizaError(
        "Cannot issue an owner pairing code: no canonical owner is configured",
        { code: "OWNER_BIND_NO_CANONICAL_OWNER" },
      );
    }

    // randomInt is crypto-strong; pad to keep leading zeros.
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = this.now() + OWNER_BIND_CODE_TTL_MS;
    this.pending.set(params.connector, {
      connector: params.connector,
      codeHash: hashCode(code),
      expiresAt,
      attemptsRemaining: OWNER_BIND_MAX_ATTEMPTS,
      ownerEntityId: ownerEntityId as UUID,
    });

    logger.info(
      {
        src: "agent:owner-binding",
        agentId: this.runtime.agentId,
        connector: params.connector,
        expiresAt,
      },
      "Issued owner pairing code",
    );

    return { connector: params.connector, code, expiresAt };
  }

  /**
   * Verify a code relayed by a connector pairing command. Interface contract
   * with the connector relays: resolves to a result object, never throws — the
   * relay turns `success:false` into a user-facing "invalid or expired" reply
   * without distinguishing failure causes (that detail stays in server logs).
   */
  async verifyOwnerBindFromConnector(
    params: OwnerBindVerifyParams,
  ): Promise<OwnerBindVerifyResult> {
    const fail = (error: string): OwnerBindVerifyResult => {
      logger.warn(
        {
          src: "agent:owner-binding",
          agentId: this.runtime.agentId,
          connector: String(params.connector),
          externalId: String(params.externalId),
          error,
        },
        "Owner pairing verification failed",
      );
      return { success: false, error };
    };

    if (!isSupportedConnector(params.connector)) {
      return fail("invalid_connector");
    }
    if (
      typeof params.externalId !== "string" ||
      params.externalId.trim().length === 0
    ) {
      return fail("invalid_external_id");
    }
    if (
      typeof params.code !== "string" ||
      !/^\d{6}$/.test(params.code.trim())
    ) {
      return fail("invalid_code_format");
    }

    const bind = this.pending.get(params.connector);
    if (!bind) {
      return fail("no_pending_bind");
    }
    if (this.now() > bind.expiresAt) {
      this.pending.delete(params.connector);
      return fail("code_expired");
    }

    bind.attemptsRemaining -= 1;
    const candidate = hashCode(params.code.trim());
    const matches =
      candidate.length === bind.codeHash.length &&
      timingSafeEqual(candidate, bind.codeHash);

    if (!matches) {
      if (bind.attemptsRemaining <= 0) {
        this.pending.delete(params.connector);
        return fail("too_many_attempts");
      }
      return fail("invalid_code");
    }

    // Single-use: consume the code before the binding write so a concurrent
    // or repeated submission of the same code can never bind twice.
    this.pending.delete(params.connector);

    try {
      await this.writeOwnerConnectorIdentity(
        bind.ownerEntityId,
        params.connector,
        params.externalId.trim(),
        params.displayHandle,
      );
    } catch (err) {
      // error-policy:J1 boundary translation — this method is the service
      // contract with the connector relays (result object, never a throw).
      // The code is already consumed (fail closed); the owner re-issues one.
      this.runtime.reportError("agent:owner-binding", err, {
        connector: params.connector,
        externalId: params.externalId,
      });
      return fail("binding_write_failed");
    }

    logger.info(
      {
        src: "agent:owner-binding",
        agentId: this.runtime.agentId,
        connector: params.connector,
        externalId: params.externalId,
        displayHandle: params.displayHandle,
      },
      "Owner pairing verified; platform identity bound to owner entity",
    );
    return { success: true };
  }

  /**
   * Record the verified platform identity on the canonical owner entity. Role
   * resolution (`resolveOwnershipRole` → `connectorIdentityMatches`) compares
   * the stable `userId`/`id` fields of the sender's connector-stamped metadata
   * against the owner entity's, so this write is exactly what makes messages
   * from the paired platform user resolve to OWNER — across every connector.
   */
  private async writeOwnerConnectorIdentity(
    ownerEntityId: UUID,
    connector: OwnerBindConnector,
    externalId: string,
    displayHandle: string,
  ): Promise<void> {
    const existing = await this.runtime.getEntityById(ownerEntityId);
    const handle =
      typeof displayHandle === "string" && displayHandle.trim().length > 0
        ? displayHandle.trim()
        : externalId;
    const connectorIdentity = {
      ...(asRecord(existing?.metadata?.[connector]) ?? {}),
      id: externalId,
      userId: externalId,
      username: handle,
      name: handle,
      ownerBindVerifiedAt: this.now(),
    };

    if (existing) {
      await this.runtime.updateEntity({
        ...existing,
        metadata: {
          ...(existing.metadata ?? {}),
          [connector]: connectorIdentity,
        },
      });
      return;
    }

    const created = await this.runtime.createEntity({
      id: ownerEntityId,
      names: [handle],
      agentId: this.runtime.agentId,
      metadata: { [connector]: connectorIdentity },
    });
    if (!created) {
      throw new ElizaError("Failed to create owner entity for pairing", {
        code: "OWNER_BIND_ENTITY_CREATE_FAILED",
        context: { ownerEntityId, connector },
      });
    }
  }
}

/** Resolve the registered {@link OwnerBindingService}, or null when absent. */
export function resolveOwnerBindingService(
  runtime: IAgentRuntime,
): OwnerBindingService | null {
  return runtime.getService<OwnerBindingService>(OWNER_BIND_VERIFY_SERVICE);
}
