/**
 * Real-PGlite proof that owner-exclusive disclosure stays bound to live room
 * membership. A DM audience attested from canonical room + participant rows
 * authorizes owner-private provider/action access; mutating the room's
 * membership between authorization and delivery-time revalidation must be
 * denied with `audience_changed` by the egress seam — the synchronous
 * pre-execution gate cannot see the mutation, which is exactly the TOCTOU
 * window the revalidation exists to close.
 */

import crypto from "node:crypto";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  attestDeliveryAudienceFromCanonicalRoom,
  authorizeOwnerExclusiveDisclosure,
  ChannelType,
  disclosureGateFailure,
  evaluateOwnerExclusiveDisclosure,
  OWNER_EXCLUSIVE_DISCLOSURE_GATE,
  revalidateOwnerExclusiveDisclosure,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";

const OWNER_ENTITY_ID = crypto.randomUUID() as UUID;
const INTRUDER_ENTITY_ID = crypto.randomUUID() as UUID;
const DM_ROOM_ID = crypto.randomUUID() as UUID;
const WORLD_ID = crypto.randomUUID() as UUID;

describe("owner-exclusive disclosure vs room-membership mutation — real PGlite rooms", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let message: Memory;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime({
      characterName: "delivery-audience-agent",
    });
    runtime = runtimeResult.runtime;
    // The audience decision requires actor === canonical owner; configure the
    // canonical owner explicitly so role resolution does not depend on world
    // ownership metadata.
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", OWNER_ENTITY_ID);
    // Real rooms + participants: ensureConnection writes the DM room row and
    // both participant rows (owner + agent) through the adapter.
    await runtime.ensureConnection({
      entityId: OWNER_ENTITY_ID,
      roomId: DM_ROOM_ID,
      worldId: WORLD_ID,
      worldName: "Delivery Audience World",
      userName: "owner",
      name: "Owner",
      source: "test",
      type: ChannelType.DM,
      channelId: DM_ROOM_ID,
    });
    message = {
      id: crypto.randomUUID() as UUID,
      entityId: OWNER_ENTITY_ID,
      agentId: runtime.agentId,
      roomId: DM_ROOM_ID,
      content: { text: "what is on my private schedule?", source: "test" },
    } as Memory;
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("attests a DM audience for the owner turn from canonical room and participant rows", async () => {
    const audience = await attestDeliveryAudienceFromCanonicalRoom(
      runtime,
      message,
    );

    expect(audience.kind).toBe("direct");
    expect(audience.provenance).toBe("canonical_room");
    expect(audience.actorEntityId).toBe(OWNER_ENTITY_ID);
    expect(audience.canonicalOwnerEntityId).toBe(OWNER_ENTITY_ID);
    expect([...audience.participantEntityIds].sort()).toEqual(
      [OWNER_ENTITY_ID, runtime.agentId].sort(),
    );
  });

  it("allows owner-exclusive provider and action access on the attested turn", async () => {
    // Plugin assembly stamps every owner-private provider with the disclosure
    // gate (ownerPrivateProvider); assert against the instance the runtime
    // actually registered, then drive the same gate seam composeState applies.
    const pendingApprovals = runtime.providers.find(
      (provider) => provider.name === "pendingApprovals",
    );
    if (!pendingApprovals) {
      throw new Error("pendingApprovals provider is not registered");
    }
    expect(pendingApprovals.disclosureGate).toEqual(
      OWNER_EXCLUSIVE_DISCLOSURE_GATE,
    );
    expect(
      disclosureGateFailure(pendingApprovals.disclosureGate, message),
    ).toBeUndefined();

    // Action-execution seam: authorization revalidates against live rows and
    // marks the turn as having consumed owner-private information.
    const decision = await authorizeOwnerExclusiveDisclosure(runtime, message);
    expect(decision.allowed).toBe(true);

    // The registered provider runs its real bounded queue read against the
    // PGlite-backed approval_requests table: designed-empty (0 pending rows)
    // is distinguishable from the unavailable error state.
    const result = await pendingApprovals.get(runtime, message, {
      values: {},
      data: {},
      text: "",
    });
    expect(result.values?.pendingApprovalCount).toBe(0);
    expect(result.values?.pendingApprovalsUnavailable).toBeUndefined();
  });

  it("denies delivery-time revalidation with audience_changed after membership mutates", async () => {
    await runtime.createEntity({
      id: INTRUDER_ENTITY_ID,
      names: ["Intruder"],
      agentId: runtime.agentId,
    });
    const added = await runtime.addParticipant(INTRUDER_ENTITY_ID, DM_ROOM_ID);
    expect(added).toBe(true);
    const participants = await runtime.getParticipantsForRoom(DM_ROOM_ID);
    expect(participants).toHaveLength(3);
    expect(participants).toContain(INTRUDER_ENTITY_ID);

    // The synchronous pre-execution gate still passes: it can only see the
    // attestation, not the mutation — the reason the egress seam re-reads
    // canonical membership before anything owner-private leaves the process.
    expect(evaluateOwnerExclusiveDisclosure(message).allowed).toBe(true);

    const decision = await revalidateOwnerExclusiveDisclosure(runtime, message);
    expect(decision).toMatchObject({
      allowed: false,
      reason: "audience_changed",
    });
  });
});
