/**
 * Per-binding participant identity authority for Personal Shared group chats.
 *
 * One call per group turn registers the speaker and returns the binding's full
 * roster: the speaker's resolved name or ordinal builds the model-facing
 * label, and the roster lets the outbound guard redact any participant's raw
 * connector handle before a reply leaves for the provider. Both come from one
 * transaction, so the roster always contains the speaker that transaction just
 * registered, and the name rules see the roster they are deciding against.
 */
import { ElizaError } from "@elizaos/core/edge";
import { asc, eq, sql } from "drizzle-orm";
import { resolveGroupParticipantDisplayName } from "../../lib/services/shared-runtime/group-participant-labels";
import type { Database } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbWrite } from "../helpers";
import {
  personalSharedGroupBindings,
  personalSharedGroupParticipants,
} from "../schemas/personal-shared-groups";

/**
 * Second advisory-lock key. The first key is the binding id, so the lock space
 * is this table's ordinal assignment for one group and nothing else — matching
 * the two-int4 house form in `eliza-provision-lock.ts`.
 */
const PARTICIPANT_ORDINAL_LOCK_SCOPE = "personal-shared-group-participant-ordinal";

export interface GroupParticipantIdentity {
  /** Raw connector handle. Server-side only; never put this in a prompt or a reply. */
  platformUserId: string;
  /** 1-based, stable within the binding. */
  ordinal: number;
  /**
   * The name the connector supplied, once it survived the resolution rules.
   * Null on a connector that sends no names, and null whenever a supplied name
   * was rejected, so the label falls back to the ordinal.
   */
  displayName: string | null;
}

export interface GroupParticipantTurn {
  /** The speaker of this turn. */
  actor: GroupParticipantIdentity;
  /** Every participant registered against the binding, ordinal ascending. */
  roster: GroupParticipantIdentity[];
}

interface ParticipantRow {
  platform_user_id: string;
  ordinal: number | string;
  display_name: string | null;
}

function toIdentity(row: ParticipantRow): GroupParticipantIdentity {
  return {
    platformUserId: row.platform_user_id,
    ordinal: Number(row.ordinal),
    displayName: row.display_name,
  };
}

function storageFailure(
  message: string,
  context: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code: "GROUP_PARTICIPANT_REGISTRY_STORAGE_FAILURE",
    severity: "fatal",
    context,
    cause,
  });
}

export class PersonalSharedGroupParticipantsRepository {
  constructor(private readonly database: Database) {}

  /**
   * Registers this turn's speaker under the binding and returns the roster.
   *
   * Ordinal assignment is `MAX(ordinal) + 1`, which is only safe if no two
   * assignments for the same binding can read the same maximum. Two guards
   * make that impossible:
   *
   *  - a binding key-share lock followed by a per-binding transaction advisory
   *    lock serializes the read-then-insert window. Rebind uses the same
   *    B -> advisory -> participant order, while unrelated groups never wait;
   *  - `personal_shared_group_participants_ordinal_uidx` is the schema-level
   *    backstop: even if the lock were somehow bypassed, a duplicate ordinal
   *    cannot be persisted, and the turn fails loudly instead of quietly
   *    giving two people the same name.
   *
   * A speaker who is already registered takes the `ON CONFLICT` branch, which
   * refreshes their name and `last_seen_at` and returns the ordinal that was
   * assigned the first time, so an ordinal is stable across a binding's whole
   * history even when the name behind it changes.
   */
  async recordTurn(input: {
    bindingId: string;
    platformUserId: string;
    /**
     * Raw, untrusted name from this turn's connector payload. Resolution and
     * rejection happen here, under the lock, because the rules depend on the
     * binding's roster; callers must not pre-filter it.
     */
    displayName?: string | null;
  }): Promise<GroupParticipantTurn> {
    if (!input.bindingId || !input.platformUserId) {
      throw new TypeError("Group participant registration identity is incomplete");
    }
    try {
      return await this.database.transaction(async (tx) => {
        const [binding] = await tx
          .select({ id: personalSharedGroupBindings.id })
          .from(personalSharedGroupBindings)
          .where(eq(personalSharedGroupBindings.id, input.bindingId))
          .limit(1)
          .for("key share");
        if (!binding) {
          throw storageFailure("Group participant registration failed", {
            bindingId: input.bindingId,
            reason: "binding_missing",
          });
        }
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtext(${input.bindingId}),
            hashtext(${PARTICIPANT_ORDINAL_LOCK_SCOPE})
          )`,
        );
        const participants = personalSharedGroupParticipants;
        // The names already claimed in this binding. Read inside the same
        // locked transaction as the write below, so the collision decision
        // cannot be raced by another speaker registering the same name.
        const claimedNames = await tx
          .select({
            platform_user_id: participants.platform_user_id,
            display_name: participants.display_name,
          })
          .from(participants)
          .where(eq(participants.binding_id, input.bindingId));
        const displayName = resolveGroupParticipantDisplayName({
          candidate: input.displayName,
          platformUserId: input.platformUserId,
          roster: claimedNames.map((row) => ({
            platformUserId: row.platform_user_id,
            displayName: row.display_name,
          })),
        });
        // The turn's payload is authoritative: a member who renames themselves
        // is renamed here, and one whose name stops being usable reverts to
        // their ordinal rather than keeping a stale label.
        const [claimed] = await sqlRows<ParticipantRow>(
          tx,
          sql`INSERT INTO ${participants}
              (binding_id, platform_user_id, ordinal, display_name, last_seen_at)
            SELECT ${input.bindingId}::uuid, ${input.platformUserId},
              COALESCE(MAX(${participants.ordinal}), 0) + 1, ${displayName}::text, now()
            FROM ${participants}
            WHERE ${participants.binding_id} = ${input.bindingId}::uuid
            ON CONFLICT (binding_id, platform_user_id) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              last_seen_at = now()
            RETURNING platform_user_id, ordinal, display_name`,
        );
        if (!claimed) {
          throw storageFailure("Group participant registration returned no row", {
            bindingId: input.bindingId,
          });
        }
        const roster = await tx
          .select({
            platform_user_id: participants.platform_user_id,
            ordinal: participants.ordinal,
            display_name: participants.display_name,
          })
          .from(participants)
          .where(eq(participants.binding_id, input.bindingId))
          .orderBy(asc(participants.ordinal));
        return { actor: toIdentity(claimed), roster: roster.map(toIdentity) };
      });
    } catch (error) {
      if (
        error instanceof ElizaError &&
        error.code === "GROUP_PARTICIPANT_REGISTRY_STORAGE_FAILURE"
      ) {
        throw error;
      }
      // error-policy:J2 the route turns this typed boundary into one structured
      // delivery failure; a group turn must never proceed with an unknown
      // speaker identity, because the label and the egress guard both depend
      // on it.
      throw storageFailure(
        "Group participant registration failed",
        { bindingId: input.bindingId },
        error,
      );
    }
  }
}

export const personalSharedGroupParticipantsRepository =
  new PersonalSharedGroupParticipantsRepository(dbWrite);
