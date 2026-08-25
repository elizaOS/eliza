/**
 * Real-PGlite integration proof for Baileys membership evidence publication.
 * The harness drives the production publisher against the canonical SQL authority.
 */
import {
  createUniqueUuid,
  getConnectorAccountManager,
  type MembershipScope,
  MembershipService,
  type UUID,
} from "@elizaos/core";
import type { GroupMetadata, GroupParticipant } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../../plugin-sql/src/__tests__/test-helpers";
import { SqlMembershipService } from "../../plugin-sql/src/services/sql-membership";
import { WhatsAppMembershipPublisher } from "./membership-publisher";

const GROUP_ID = "120363000000001@g.us";
const SECOND_GROUP_ID = "120363000000002@g.us";
const ALICE = "14155550101@s.whatsapp.net";
const BOB = "14155550102@s.whatsapp.net";

function participant(id: string, admin: "admin" | "superadmin" | null = null): GroupParticipant {
  return { id, admin };
}

function group(
  participants: GroupParticipant[],
  id = GROUP_ID,
  overrides: Partial<GroupMetadata> = {}
): GroupMetadata {
  return {
    id,
    subject: `Evidence ${id}`,
    owner: ALICE,
    creation: 1,
    size: participants.length,
    participants,
    ...overrides,
  };
}

describe("WhatsAppMembershipPublisher real authority", () => {
  let cleanup: () => Promise<void>;
  let runtime: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["runtime"];
  let authority: SqlMembershipService;
  let nowMs: number;

  beforeEach(async () => {
    const setup = await createIsolatedTestDatabase(`whatsapp_membership_${crypto.randomUUID()}`);
    cleanup = setup.cleanup;
    runtime = setup.runtime;
    nowMs = Date.parse("2026-08-25T06:00:00.000Z");
    authority = new SqlMembershipService(runtime, () => new Date(nowMs));
    runtime.services.set(MembershipService.serviceType, [authority]);
  }, 30_000);

  afterEach(async () => {
    await authority.stop();
    await cleanup();
  }, 30_000);

  function principalId(accountId: string, externalId: string): UUID {
    return createUniqueUuid(
      runtime,
      accountId === "default"
        ? `whatsapp-entity:${externalId}`
        : `whatsapp-entity:${accountId}:${externalId}`
    ) as UUID;
  }

  async function scopeFor(accountId: string, roomId = GROUP_ID): Promise<MembershipScope> {
    const account = await getConnectorAccountManager(runtime).getAccount("whatsapp", accountId);
    expect(account?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    return {
      agentId: runtime.agentId,
      connectorId: "whatsapp",
      connectorAccountId: account?.id as UUID,
      externalWorldId: `baileys:${roomId}`,
      externalRoomId: roomId,
    };
  }

  it("publishes a complete roster plus add/remove/promote/demote deltas without stale resurrection", async () => {
    const publisher = new WhatsAppMembershipPublisher(runtime, "default", () => new Date(nowMs));
    const alice = participant(ALICE);
    const bob = participant(BOB);
    await publisher.publishReconnectSnapshot([group([alice, bob])]);
    const scope = await scopeFor("default");
    await expect(authority.authorize(scope, principalId("default", ALICE))).resolves.toMatchObject({
      decision: "allowed",
    });

    await publisher.publishParticipantDelta(
      { id: GROUP_ID, author: ALICE, participants: [alice], action: "promote" },
      async () => group([participant(ALICE, "admin"), bob])
    );
    await expect(
      authority.getMembership(scope, principalId("default", ALICE))
    ).resolves.toMatchObject({ state: "active", roles: ["member", "admin"] });

    await publisher.publishParticipantDelta(
      { id: GROUP_ID, author: ALICE, participants: [alice], action: "demote" },
      async () => group([alice, bob])
    );
    await expect(
      authority.getMembership(scope, principalId("default", ALICE))
    ).resolves.toMatchObject({ state: "active", roles: ["member"] });

    const failedRemovalQuery = async (): Promise<GroupMetadata> => {
      throw new Error("point query unavailable");
    };
    await publisher.publishParticipantDelta(
      { id: GROUP_ID, author: BOB, participants: [bob], action: "remove" },
      failedRemovalQuery
    );
    await expect(
      authority.getMembership(scope, principalId("default", BOB))
    ).resolves.toMatchObject({ state: "revoked", reason: "left" });

    await publisher.publishParticipantDelta(
      { id: GROUP_ID, author: ALICE, participants: [bob], action: "add" },
      async () => group([alice])
    );
    await expect(authority.authorize(scope, principalId("default", BOB))).resolves.toMatchObject({
      decision: "denied",
      reason: "membership_revoked",
    });

    await publisher.publishParticipantDelta(
      { id: GROUP_ID, author: ALICE, participants: [bob], action: "add" },
      async () => group([alice, bob])
    );
    await expect(authority.authorize(scope, principalId("default", BOB))).resolves.toMatchObject({
      decision: "allowed",
    });
  });

  it("preserves roster facts across reconnect failure, then repairs a missed removal", async () => {
    const publisher = new WhatsAppMembershipPublisher(runtime, "default", () => new Date(nowMs));
    await publisher.publishReconnectSnapshot([group([participant(ALICE), participant(BOB)])]);
    const scope = await scopeFor("default");
    const bobId = principalId("default", BOB);

    await publisher.markDisconnected();
    await expect(authority.getScopeHealth(scope)).resolves.toMatchObject({
      health: "unavailable",
    });
    await expect(authority.getMembership(scope, bobId)).resolves.toMatchObject({ state: "active" });

    await publisher.reportReconnectFailure("paginated_incomplete");
    await expect(authority.getScopeHealth(scope)).resolves.toMatchObject({
      health: "stale",
      reason: "paginated_incomplete",
    });
    await expect(authority.getMembership(scope, bobId)).resolves.toMatchObject({ state: "active" });

    nowMs += 1_000;
    await publisher.publishReconnectSnapshot([group([participant(ALICE)])]);
    await expect(authority.getMembership(scope, bobId)).resolves.toMatchObject({
      state: "revoked",
      reason: "reconciled_absent",
    });
  });

  it("treats a complete empty group and an absent reconnect group as authoritative", async () => {
    const publisher = new WhatsAppMembershipPublisher(runtime, "default", () => new Date(nowMs));
    await publisher.publishReconnectSnapshot([
      group([participant(ALICE)]),
      group([participant(BOB)], SECOND_GROUP_ID),
    ]);
    const firstScope = await scopeFor("default");
    const secondScope = await scopeFor("default", SECOND_GROUP_ID);

    await publisher.markDisconnected();
    nowMs += 1_000;
    await publisher.publishReconnectSnapshot([group([], GROUP_ID)]);

    await expect(
      authority.authorize(firstScope, principalId("default", ALICE))
    ).resolves.toMatchObject({ decision: "denied", reason: "membership_revoked" });
    await expect(
      authority.authorize(secondScope, principalId("default", BOB))
    ).resolves.toMatchObject({ decision: "denied", reason: "membership_revoked" });
  });

  it("isolates identical rooms and principals across connector accounts", async () => {
    const first = new WhatsAppMembershipPublisher(runtime, "account-a", () => new Date(nowMs));
    const second = new WhatsAppMembershipPublisher(runtime, "account-b", () => new Date(nowMs));
    await first.publishReconnectSnapshot([group([participant(ALICE)])]);
    await second.publishReconnectSnapshot([group([participant(ALICE)])]);
    const firstScope = await scopeFor("account-a");
    const secondScope = await scopeFor("account-b");
    expect(firstScope.connectorAccountId).not.toBe(secondScope.connectorAccountId);
    expect(firstScope.externalWorldId).toBe("baileys:120363000000001@g.us");

    await first.publishParticipantDelta(
      { id: GROUP_ID, author: BOB, participants: [participant(ALICE)], action: "remove" },
      async () => group([])
    );
    await expect(
      authority.authorize(firstScope, principalId("account-a", ALICE))
    ).resolves.toMatchObject({ decision: "denied", reason: "membership_revoked" });
    await expect(
      authority.authorize(secondScope, principalId("account-b", ALICE))
    ).resolves.toMatchObject({ decision: "allowed" });
  });

  it("fails closed on source termination without fabricating a removal", async () => {
    const publisher = new WhatsAppMembershipPublisher(runtime, "default", () => new Date(nowMs));
    await publisher.publishReconnectSnapshot([group([participant(ALICE)])]);
    const scope = await scopeFor("default");
    const aliceId = principalId("default", ALICE);

    await publisher.terminate("baileys_logged_out");
    await expect(authority.authorize(scope, aliceId)).resolves.toMatchObject({
      decision: "denied",
      reason: "authority_unavailable",
    });
    await expect(authority.getMembership(scope, aliceId)).resolves.toMatchObject({
      state: "active",
    });

    await publisher.publishParticipantDelta(
      { id: GROUP_ID, author: BOB, participants: [participant(ALICE)], action: "remove" },
      async () => group([])
    );
    await expect(authority.getMembership(scope, aliceId)).resolves.toMatchObject({
      state: "active",
    });
  });
});
