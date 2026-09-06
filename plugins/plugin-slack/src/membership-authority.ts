/**
 * Publishes Slack Web API membership evidence to the canonical
 * MembershipService authority (issue #24367). `renewChannelMembership` and
 * the member join/leave handlers feed this publisher: a completed
 * `conversations.members` walk becomes a complete snapshot, an unavailable
 * read becomes an incomplete-snapshot report (stale, never mass-revoked),
 * and join/leave events become ordered deltas. Fencing discipline follows
 * the authority contract: stable per-process publisher identity, durable
 * generation adoption across restarts, observation-derived idempotency
 * keys, and fail-closed degradation. When no MembershipService authority is
 * registered the publisher is absent and the service keeps legacy
 * runtime-participation behavior.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  IAgentRuntime,
  JsonObject,
  MembershipScope,
  MembershipService,
  UUID,
} from "@elizaos/core";
import { ElizaError, ServiceType } from "@elizaos/core";

import type { SlackMembershipReadResult } from "./membership";

/** Connector id the authority's connector_accounts provider expects. */
export const SLACK_MEMBERSHIP_CONNECTOR_ID = "slack";

/** Evidence validity window for roster snapshots (1 hour). */
export const SLACK_MEMBERSHIP_TTL_MS = 60 * 60 * 1000;

/**
 * The authority validates UUID version nibbles ([1-8]); createUniqueUuid /
 * stringToUuid-derived ids carry the custom 0x0 version nibble and are
 * rejected with MEMBERSHIP_COMMAND_INVALID, so derived runtime ids are only
 * forwarded when pattern-valid.
 */
export const AUTHORITY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 16-byte namespace seed for deterministic RFC-4122 v5 principal ids. */
const SLACK_MEMBERSHIP_NAMESPACE = createHash("sha1")
  .update("elizaos:plugin-slack:membership:v1")
  .digest()
  .subarray(0, 16);

function uuidV5(name: string): UUID {
  // RFC 4122 4.3: SHA-1 over namespace bytes || name, then set version 5
  // and variant bits. Implemented with node:crypto so this plugin carries no
  // uuid dependency.
  const digest = createHash("sha1")
    .update(SLACK_MEMBERSHIP_NAMESPACE)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as UUID;
}

/**
 * Canonical principal id for one Slack workspace user, for the membership
 * authority. Deterministic RFC-4122 v5 over (account key, Slack user id):
 * stable across restarts and publishers, and pattern-valid for the
 * authority's [1-8] version-nibble check.
 */
export function slackMembershipPrincipalId(
  accountKey: string,
  slackUserId: string,
): UUID {
  return uuidV5(`${accountKey}:${slackUserId}`);
}

/**
 * Authority scope for one admitted Slack channel. `externalWorldId` is the
 * workspace team id (a channel's membership lives inside exactly one
 * workspace) and `externalRoomId` the channel id, keyed per connector
 * account so separate account rows never alias scopes.
 */
export function slackMembershipScope(input: {
  agentId: UUID;
  connectorAccountId: UUID;
  teamId: string;
  channelId: string;
}): MembershipScope {
  return {
    agentId: input.agentId,
    connectorId: SLACK_MEMBERSHIP_CONNECTOR_ID,
    connectorAccountId: input.connectorAccountId,
    externalWorldId: input.teamId,
    externalRoomId: input.channelId,
  };
}

/**
 * Deterministic authority connector-account id for one account record.
 * Used when the account storage echoes a non-UUID record id: the authority
 * keys every scope by a versioned-UUID connectorAccountId, so the v5
 * derivation keeps scope identity stable across restarts.
 */
export function slackMembershipAccountId(accountRecordId: string): UUID {
  return uuidV5(`account:${accountRecordId}`);
}

export function isMembershipService(
  service: unknown,
): service is MembershipService {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as MembershipService).registerPublisher === "function" &&
    typeof (service as MembershipService).applyCompleteSnapshot === "function"
  );
}

export function resolveMembershipService(
  runtime: IAgentRuntime,
): MembershipService | null {
  const service = runtime.getService(ServiceType.MEMBERSHIP);
  return isMembershipService(service) ? service : null;
}

function scopeKey(scope: MembershipScope): string {
  return `${scope.connectorAccountId}:${scope.externalWorldId}:${scope.externalRoomId}`;
}

function membershipErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "";
}

/** Error codes the authority surfaces for fence collisions. */
const FENCE_CODES = new Set([
  "MEMBERSHIP_GENERATION_FENCE",
  "MEMBERSHIP_GENERATION_MISMATCH",
  "MEMBERSHIP_PUBLISHER_FENCE",
  "MEMBERSHIP_PUBLISHER_MISMATCH",
  "MEMBERSHIP_PUBLISHER_GENERATION_STALE",
  "MEMBERSHIP_CURSOR_FENCE",
  "MEMBERSHIP_CURSOR_DISCONTINUITY",
  "MEMBERSHIP_PUBLISH_TAKEN_OVER",
]);

interface ScopeTracker {
  generation: number;
  publisherGeneration: number;
  sourceVersion: number;
  sourceCursor: string | null;
  degraded: boolean;
}

/**
 * Publication failure of one evidence command after fenced retries: the
 * authority kept rejecting the publish (fence collisions or idempotency
 * conflicts the retry could not reconcile). The scope keeps its prior
 * authoritative state; the caller sees the typed failure instead of a
 * fabricated success, and the snapshot read result still flows back to
 * runtime-participation renewal.
 */
export class SlackMembershipPublishError extends ElizaError {
  constructor(
    message: string,
    options?: { cause?: unknown; context?: Record<string, unknown> },
  ) {
    super(message, {
      code: "SLACK_MEMBERSHIP_PUBLISH_FAILED",
      context: options?.context,
      cause: options?.cause,
      severity: "ephemeral",
    });
  }
}

/** Runtime-mapping derivation the publisher shares with the service. */
export interface SlackMembershipRuntimeIds {
  worldId: UUID | null;
  roomId: UUID | null;
  entityId: UUID | null;
}

/**
 * Publisher of Slack Web API membership evidence to the canonical
 * MembershipService authority. One instance per (runtime, connector
 * account). Authority mutations are serialized per scope; the connector
 * always publishes with evidenceMode "ordered_delta" (snapshots and deltas
 * share one cursor chain per the authority's registration contract).
 */
export class SlackMembershipPublisher {
  private readonly runtime: IAgentRuntime;
  private readonly connectorAccountId: UUID;
  private readonly accountKey: string;
  private readonly service: MembershipService;
  private readonly publisherInstanceId: string;
  private readonly scopes = new Map<string, ScopeTracker>();
  private readonly chains = new Map<string, Promise<unknown>>();

  /** Maps a channel id to its runtime ids, mirroring the service's derivation. */
  private readonly deriveRuntimeIds: (input: {
    channelId: string;
    slackUserId: string;
  }) => SlackMembershipRuntimeIds;
  /** Ensures authority-visible principal entity rows exist. */
  private readonly ensurePrincipalEntity: (
    principalId: UUID,
    slackUserId: string,
  ) => Promise<void>;
  /** Ensures the authority-visible room and world rows exist. */
  private readonly ensureRuntimeRoomAndWorld: (
    runtimeIds: SlackMembershipRuntimeIds,
    channelId: string,
  ) => Promise<void>;

  constructor(input: {
    runtime: IAgentRuntime;
    connectorAccountId: UUID;
    accountKey: string;
    service: MembershipService;
    publisherInstanceId?: string;
    deriveRuntimeIds: (input: {
      channelId: string;
      slackUserId: string;
    }) => SlackMembershipRuntimeIds;
    ensurePrincipalEntity: (
      principalId: UUID,
      slackUserId: string,
    ) => Promise<void>;
    ensureRuntimeRoomAndWorld: (
      runtimeIds: SlackMembershipRuntimeIds,
      channelId: string,
    ) => Promise<void>;
  }) {
    this.runtime = input.runtime;
    this.connectorAccountId = input.connectorAccountId;
    this.accountKey = input.accountKey;
    this.service = input.service;
    this.publisherInstanceId =
      input.publisherInstanceId ?? `slack-${randomUUID()}`;
    this.deriveRuntimeIds = input.deriveRuntimeIds;
    this.ensurePrincipalEntity = input.ensurePrincipalEntity;
    this.ensureRuntimeRoomAndWorld = input.ensureRuntimeRoomAndWorld;
  }

  /** Per-scope serialization: authority mutations for one scope must chain. */
  private serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.chains.set(key, next);
    return next;
  }

  private trackerFor(scope: MembershipScope): ScopeTracker {
    const key = scopeKey(scope);
    let tracker = this.scopes.get(key);
    if (!tracker) {
      tracker = {
        generation: 0,
        publisherGeneration: 0,
        sourceVersion: 0,
        sourceCursor: null,
        degraded: false,
      };
      this.scopes.set(key, tracker);
    }
    return tracker;
  }

  /**
   * Register this process as the scope publisher, adopting durable scope
   * state so a restarted process re-binds without losing fencing: when the
   * durable health row already belongs to this stable publisher identity,
   * re-bind at the same generation instead of resetting the evidence chain.
   */
  private async ensureRegistered(
    scope: MembershipScope,
  ): Promise<ScopeTracker> {
    const tracker = this.trackerFor(scope);
    if (tracker.generation > 0) return tracker;

    const health = await this.service.getScopeHealth(scope);
    if (health) {
      tracker.generation = health.generation;
      tracker.sourceVersion = health.sourceVersion;
      tracker.sourceCursor = health.sourceCursor;
      // Registration must strictly advance the durable publisher
      // generation (the authority rejects <= current, even for the same
      // publisher instance re-binding after a restart).
      tracker.publisherGeneration = (health.publisherGeneration ?? 0) + 1;
    }

    const receipt = await this.service.registerPublisher({
      ...scope,
      publisherInstanceId: this.publisherInstanceId,
      publisherGeneration: tracker.publisherGeneration,
      evidenceMode: "ordered_delta",
      expectedGeneration: tracker.generation,
      idempotencyKey: `slack:publisher:${this.publisherInstanceId}:${tracker.publisherGeneration}:${scope.externalRoomId}`,
      observedAt: new Date().toISOString(),
    });
    // Registration resets the durable evidence chain (sourceVersion -1,
    // cursor null) and advances the generation: adopt the post-registration
    // chain state so the first snapshot starts the cursor at 0.
    tracker.generation = receipt.committedGeneration;
    tracker.sourceVersion = -1;
    tracker.sourceCursor = null;
    return tracker;
  }

  /** Re-adopt durable state after a fence collision. */
  private async readoptFromHealth(
    scope: MembershipScope,
  ): Promise<ScopeTracker> {
    const tracker = this.trackerFor(scope);
    const health = await this.service.getScopeHealth(scope);
    if (health) {
      tracker.generation = health.generation;
      tracker.sourceVersion = health.sourceVersion;
      tracker.sourceCursor = health.sourceCursor;
      // Re-registration must strictly advance the durable publisher
      // generation (the authority rejects <= current).
      tracker.publisherGeneration = (health.publisherGeneration ?? 0) + 1;
    }
    const receipt = await this.service.registerPublisher({
      ...scope,
      publisherInstanceId: this.publisherInstanceId,
      publisherGeneration: tracker.publisherGeneration,
      evidenceMode: "ordered_delta",
      expectedGeneration: tracker.generation,
      idempotencyKey: `slack:publisher:${this.publisherInstanceId}:${tracker.publisherGeneration}:readopt:${scope.externalRoomId}`,
      observedAt: new Date().toISOString(),
    });
    tracker.generation = receipt.committedGeneration;
    tracker.sourceVersion = -1;
    tracker.sourceCursor = null;
    return tracker;
  }

  private scopeFor(teamId: string, channelId: string): MembershipScope {
    return slackMembershipScope({
      agentId: this.runtime.agentId,
      connectorAccountId: this.connectorAccountId,
      teamId,
      channelId,
    });
  }

  /**
   * Publish a completed `conversations.members` walk as a complete
   * snapshot. Returns true when the authority committed new evidence; false
   * on a benign idempotent replay. The caller's runtime-participation
   * renewal is independent and unaffected by the publish outcome.
   */
  async publishSnapshot(input: {
    teamId: string;
    channelId: string;
    memberIds: readonly string[];
    botUserId: string | null;
    observedAt?: string;
  }): Promise<boolean> {
    const scope = this.scopeFor(input.teamId, input.channelId);
    const key = scopeKey(scope);
    return this.serialized(key, async () => {
      let tracker = await this.ensureRegistered(scope);
      const observedAt = input.observedAt ?? new Date().toISOString();
      const observedAtMs = Date.parse(observedAt);
      if (!Number.isFinite(observedAtMs)) {
        throw new Error(
          `membership snapshot observedAt is not a finite timestamp: ${observedAt}`,
        );
      }
      // Idempotency key derived from the observation identity: the authority
      // journals keys per account and rejects a reused key whose digest
      // differs, so a restart (counter reset) or a repeated renewal of a
      // live adapter must never collide with a previously journaled key.
      const observedToken = observedAtMs.toString(36);
      const snapshotKey = `slack:snapshot:${this.accountKey}:${input.channelId}:${observedToken}`;

      const members = [];
      for (const memberId of input.memberIds) {
        if (memberId === input.botUserId) continue;
        const principalId = slackMembershipPrincipalId(
          this.accountKey,
          memberId,
        );
        await this.ensurePrincipalEntity(principalId, memberId);
        const runtimeIds = this.deriveRuntimeIds({
          channelId: input.channelId,
          slackUserId: memberId,
        });
        members.push({
          canonicalPrincipalId: principalId,
          roles: ["member"],
          permissionSnapshot: {
            connector: "slack",
            accountId: this.accountKey,
            slackUserId: memberId,
          } as JsonObject,
          runtime: runtimeIds,
        });
      }
      const firstRuntimeIds =
        members.length > 0
          ? members[0].runtime
          : this.deriveRuntimeIds({
              channelId: input.channelId,
              slackUserId: input.channelId,
            });
      await this.ensureRuntimeRoomAndWorld(firstRuntimeIds, input.channelId);

      for (let attempt = 0; attempt < 2; attempt++) {
        const sourceVersion = tracker.sourceVersion + 1;
        const sourceCursor = `slack:${this.accountKey}:${input.channelId}:${sourceVersion}`;
        const attemptKey =
          attempt === 0 ? snapshotKey : `${snapshotKey}:r${attempt}`;
        try {
          await this.service.applyCompleteSnapshot({
            ...scope,
            publisherInstanceId: this.publisherInstanceId,
            publisherGeneration: tracker.publisherGeneration,
            evidenceMode: "ordered_delta",
            expectedGeneration: tracker.generation,
            sourceVersion,
            previousSourceCursor: tracker.sourceCursor,
            sourceCursor,
            validUntil: new Date(
              Date.parse(observedAt) + SLACK_MEMBERSHIP_TTL_MS,
            ).toISOString(),
            completeness: "complete",
            members,
            idempotencyKey: attemptKey,
            observedAt,
          });
          tracker.generation += 1;
          tracker.sourceVersion = sourceVersion;
          tracker.sourceCursor = sourceCursor;
          tracker.degraded = false;
          return true;
        } catch (error) {
          const code = membershipErrorCode(error);
          if (code === "MEMBERSHIP_IDEMPOTENCY_CONFLICT") {
            // The reused key carried a DIFFERENT command digest — not an
            // identical replay. Retrying once under a fresh derived key
            // reconciles the divergence.
            continue;
          }
          if (FENCE_CODES.has(code)) {
            tracker = await this.readoptFromHealth(scope);
            continue;
          }
          // error-policy:J2 Non-fencing failures (storage outage) propagate
          // as a typed wrapper preserving the cause: the scope keeps its
          // previous authoritative state and the caller sees the failure
          // instead of a fabricated success.
          throw new SlackMembershipPublishError(
            `roster snapshot publish failed: ${membershipErrorCode(error) || "unknown"}`,
            {
              cause: error,
              context: {
                accountKey: this.accountKey,
                channelId: input.channelId,
              },
            },
          );
        }
      }
      throw new SlackMembershipPublishError(
        "roster snapshot commit exhausted its fenced retries",
        {
          context: { accountKey: this.accountKey, channelId: input.channelId },
        },
      );
    });
  }

  /**
   * Publish one join/leave observation as an ordered delta. Requires a
   * current complete snapshot in this publisher generation (the authority
   * rejects deltas before a baseline with MEMBERSHIP_SNAPSHOT_REQUIRED); a
   * join for an unknown baseline is skipped because the next snapshot sweep
   * will carry it.
   */
  async publishDelta(input: {
    teamId: string;
    channelId: string;
    slackUserId: string;
    joined: boolean;
    reason: "joined" | "left" | "kicked";
    observedAt?: string;
  }): Promise<boolean> {
    const scope = this.scopeFor(input.teamId, input.channelId);
    const key = scopeKey(scope);
    return this.serialized(key, async () => {
      const tracker = this.trackerFor(scope);
      if (tracker.degraded) return false;
      // Deltas need a current baseline; before the first snapshot the
      // connector must not fabricate a partial baseline from one event.
      if (tracker.sourceCursor === null) return false;
      const principalId = slackMembershipPrincipalId(
        this.accountKey,
        input.slackUserId,
      );
      await this.ensurePrincipalEntity(principalId, input.slackUserId);
      const runtimeIds = this.deriveRuntimeIds({
        channelId: input.channelId,
        slackUserId: input.slackUserId,
      });
      const observedAt = input.observedAt ?? new Date().toISOString();
      const observedAtMs = Date.parse(observedAt);
      if (!Number.isFinite(observedAtMs)) {
        throw new Error(
          `membership delta observedAt is not a finite timestamp: ${observedAt}`,
        );
      }
      const deltaKey = `slack:delta:${this.accountKey}:${input.channelId}:${input.slackUserId}:${input.reason}:${observedAtMs.toString(36)}`;
      const sourceVersion = tracker.sourceVersion + 1;
      const sourceCursor = `slack:${this.accountKey}:${input.channelId}:${sourceVersion}`;
      try {
        const receipt = await this.service.applyMembership({
          ...scope,
          publisherInstanceId: this.publisherInstanceId,
          publisherGeneration: tracker.publisherGeneration,
          evidenceMode: "ordered_delta",
          expectedGeneration: tracker.generation,
          canonicalPrincipalId: principalId,
          state: input.joined ? "active" : "revoked",
          reason: input.reason,
          roles: ["member"],
          permissionSnapshot: {
            connector: "slack",
            accountId: this.accountKey,
            slackUserId: input.slackUserId,
          } as JsonObject,
          runtime: runtimeIds,
          sourceVersion,
          previousSourceCursor: tracker.sourceCursor,
          sourceCursor,
          validUntil: new Date(
            Date.parse(observedAt) + SLACK_MEMBERSHIP_TTL_MS,
          ).toISOString(),
          idempotencyKey: deltaKey,
          observedAt,
        });
        tracker.generation = receipt.committedGeneration;
        tracker.sourceVersion = sourceVersion;
        tracker.sourceCursor = sourceCursor;
        return true;
      } catch (error) {
        const code = membershipErrorCode(error);
        if (code === "MEMBERSHIP_IDEMPOTENCY_CONFLICT") {
          return false;
        }
        if (code === "MEMBERSHIP_SNAPSHOT_REQUIRED") {
          // No complete baseline in this publisher generation: the next
          // snapshot sweep is the authoritative evidence path.
          return false;
        }
        if (FENCE_CODES.has(code)) {
          await this.readoptFromHealth(scope);
          return false;
        }
        // error-policy:J2 Storage failures propagate as a typed wrapper
        // preserving the cause: the member keeps its prior authoritative
        // state and the caller sees the failure.
        throw new SlackMembershipPublishError(
          `membership delta publish failed: ${membershipErrorCode(error) || "unknown"}`,
          {
            cause: error,
            context: {
              accountKey: this.accountKey,
              channelId: input.channelId,
              slackUserId: input.slackUserId,
            },
          },
        );
      }
    });
  }

  /**
   * Publish an unavailable roster read as an incomplete snapshot report so
   * the scope health goes stale — consumers see unavailable evidence, never
   * an empty roster implying mass removal. A degraded scope stops accepting
   * deltas until a fresh snapshot restores it.
   */
  async reportUnavailable(input: {
    teamId: string;
    channelId: string;
    reason: string;
    observedAt?: string;
  }): Promise<void> {
    const scope = this.scopeFor(input.teamId, input.channelId);
    const key = scopeKey(scope);
    await this.serialized(key, async () => {
      let tracker = this.trackerFor(scope);
      // Fail-closed from the moment the unavailable read is observed: a
      // later authority failure must not leave the scope accepting deltas
      // against the pre-unavailable cursor.
      tracker.degraded = true;
      // An unavailable read may be the first authority mutation of this
      // process: adopt the durable generation before reporting so the fence
      // accepts the command.
      if (tracker.generation === 0) {
        tracker = await this.ensureRegistered(scope);
        tracker.degraded = true;
      }
      try {
        await this.service.reportIncompleteSnapshot({
          ...scope,
          publisherInstanceId: this.publisherInstanceId,
          publisherGeneration: tracker.publisherGeneration,
          evidenceMode: "ordered_delta",
          completeness: "incomplete",
          expectedGeneration: tracker.generation,
          reason: input.reason,
          idempotencyKey: `slack:unavailable:${this.accountKey}:${input.channelId}:${Date.now()}`,
          observedAt: input.observedAt ?? new Date().toISOString(),
        });
        tracker.generation += 1;
        tracker.degraded = true;
      } catch (error) {
        const code = membershipErrorCode(error);
        if (FENCE_CODES.has(code)) {
          tracker = await this.readoptFromHealth(scope);
          // error-policy:J4 The report did not commit; the local degraded
          // flag still stops deltas and the caller still sees the
          // unavailable read result. Surface the failure.
          this.runtime.reportError?.("slack:membership:unavailable", error, {
            accountKey: this.accountKey,
            channelId: input.channelId,
          });
          return;
        }
        // error-policy:J4 The authority itself is unreachable; keep the
        // local degraded flag (fail-closed) and surface the failure.
        this.runtime.reportError?.("slack:membership:unavailable", error, {
          accountKey: this.accountKey,
          channelId: input.channelId,
        });
      }
    });
  }
}

/**
 * Adapts one SlackMembershipReadResult's unavailable reason to the
 * incomplete-snapshot report's reason string.
 */
export function unavailableReadReason(
  result: Extract<SlackMembershipReadResult, { kind: "unavailable" }>,
): string {
  return `slack conversations.members unavailable: ${result.reason}`;
}
