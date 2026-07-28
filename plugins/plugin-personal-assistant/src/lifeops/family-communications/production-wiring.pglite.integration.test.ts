/**
 * Real-PGlite proof for the production family action, connector-authenticated
 * non-owner ingress, short-lived attestations, and structural child schedule
 * projection. Spoofed or ambiguous identity metadata must fail closed.
 */
import { randomUUID } from "node:crypto";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  type Memory,
  setEntityRole,
  type UUID,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { personalAssistantPlugin } from "../../plugin.js";
import {
  createHouseholdCoordinationService,
  type HouseholdCoordinationService,
} from "../household/service.js";
import {
  AuthenticatedRuntimeSpeakerVerifierService,
  getAuthenticatedRuntimeSpeakerVerifier,
  issueAuthenticatedMessageSpeakerAttestation,
} from "./authenticated-speaker-verifier.js";
import {
  createFamilyCommunicationsAction,
  getFamilyCommunicationsService,
} from "./index.js";
import {
  HOUSEHOLD_CHILD_WEEK_SOURCE_REF,
  resolveAuthenticatedFamilyPrincipal,
  resolveTrustedChildWeekItems,
} from "./production-wiring.js";
import {
  FAMILY_COMMUNICATIONS_SERVICE,
  FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_SERVICE,
  FamilyCommunicationsRuntimeService,
} from "./service.js";

describe("family communications production wiring — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let household: HouseholdCoordinationService;
  const verifiedChildId = randomUUID();
  const unverifiedChildId = randomUUID();
  const ambiguousChildOneId = randomUUID();
  const ambiguousChildTwoId = randomUUID();
  const outsiderId = randomUUID();
  const verifiedHandle = `telegram-${randomUUID()}`;
  const unverifiedHandle = `telegram-${randomUUID()}`;
  const ambiguousHandle = `telegram-${randomUUID()}`;
  const testRoomId = randomUUID() as UUID;
  const testWorldId = randomUUID() as UUID;

  async function putPerson(input: {
    entityId: string;
    handle?: string;
    verified?: boolean;
  }): Promise<void> {
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const now = new Date().toISOString();
    await graph.getEntityStore(runtime.agentId).upsert({
      entityId: input.entityId,
      type: "person",
      preferredName: input.entityId,
      identities: input.handle
        ? [
            {
              platform: "telegram",
              handle: input.handle,
              verified: input.verified ?? true,
              confidence: 1,
              addedAt: now,
              addedVia: "import",
              evidence: ["Owner-verified connector identity."],
            },
          ]
        : [],
      tags: ["family-production-wiring-test"],
      visibility: "owner_only",
      state: {},
    });
  }

  async function bindChild(entityId: string): Promise<void> {
    await household.bindRole({
      entityId,
      role: "child",
      subjectEntityIds: [entityId],
      boundByEntityId: SELF_ENTITY_ID,
      evidence: "Owner confirmed the child identity.",
    });
    await household.issueGrant({
      principalEntityId: entityId,
      role: "child",
      subjectEntityIds: [entityId],
      scopes: ["household.visibility", "calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
  }

  async function establishRuntimeUser(entityId: string): Promise<void> {
    await runtime.ensureConnection({
      entityId: entityId as UUID,
      roomId: testRoomId,
      worldId: testWorldId,
      worldName: "Family production wiring test",
      userName: entityId,
      name: entityId,
      source: "test",
      type: ChannelType.GROUP,
      channelId: testRoomId,
    });
    const seed = createMessageMemory({
      id: randomUUID() as UUID,
      entityId: entityId as UUID,
      agentId: runtime.agentId,
      roomId: testRoomId,
      content: { text: "seed user role", source: "test" },
    });
    seed.worldId = testWorldId;
    await setEntityRole(runtime, seed, entityId, "USER");
  }

  function connectorMessage(input: {
    entityId: string;
    handle: string;
    provider?: string;
    chatType?: string;
    text?: string;
  }): Memory {
    const provider = input.provider ?? "telegram";
    const message = createMessageMemory({
      id: randomUUID() as UUID,
      entityId: input.entityId as UUID,
      agentId: runtime.agentId,
      roomId: testRoomId,
      content: {
        text: input.text ?? "buy shoes",
        source: provider,
      },
    });
    message.worldId = testWorldId;
    message.metadata = {
      type: "message",
      provider,
      chatType: input.chatType ?? "dm",
      accountId: "family-test-account",
      [provider]: {
        userId: input.handle,
        id: input.handle,
        chatId: `chat-${input.handle}`,
        messageId: `message-${randomUUID()}`,
      },
    };
    return message;
  }

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    await graph.getEntityStore(runtime.agentId).ensureSelf();
    household = createHouseholdCoordinationService(runtime);
    await putPerson({
      entityId: verifiedChildId,
      handle: verifiedHandle,
    });
    await putPerson({
      entityId: unverifiedChildId,
      handle: unverifiedHandle,
      verified: false,
    });
    await putPerson({
      entityId: ambiguousChildOneId,
      handle: ambiguousHandle,
    });
    await putPerson({
      entityId: ambiguousChildTwoId,
      handle: ambiguousHandle,
    });
    await putPerson({ entityId: outsiderId });
    for (const entityId of [
      verifiedChildId,
      unverifiedChildId,
      ambiguousChildOneId,
      ambiguousChildTwoId,
      outsiderId,
    ]) {
      await establishRuntimeUser(entityId);
    }
    for (const entityId of [
      verifiedChildId,
      unverifiedChildId,
      ambiguousChildOneId,
      ambiguousChildTwoId,
    ]) {
      await bindChild(entityId);
    }
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("registers the action and ordered runtime verifier/service in the production plugin", () => {
    const serviceTypes = (personalAssistantPlugin.services ?? []).map(
      (service) => service.serviceType,
    );
    expect(serviceTypes).toContain(
      AuthenticatedRuntimeSpeakerVerifierService.serviceType,
    );
    expect(serviceTypes).toContain(
      FamilyCommunicationsRuntimeService.serviceType,
    );
    expect(
      serviceTypes.indexOf(FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_SERVICE),
    ).toBeLessThan(serviceTypes.indexOf(FAMILY_COMMUNICATIONS_SERVICE));
    expect(
      personalAssistantPlugin.actions?.map((action) => action.name),
    ).toEqual(
      expect.arrayContaining([
        "FAMILY_COMMUNICATIONS",
        "FAMILY_COMMUNICATIONS_CAPTURE_VOICE_BUNDLE",
        "FAMILY_COMMUNICATIONS_CHILD_WEEK",
      ]),
    );
    expect(getAuthenticatedRuntimeSpeakerVerifier(runtime)).not.toBeNull();
    expect(getFamilyCommunicationsService(runtime)).not.toBeNull();
  });

  it("uses a verified direct-message identity to mint a short-lived attestation and run the inert action path", async () => {
    const message = connectorMessage({
      entityId: verifiedChildId,
      handle: verifiedHandle,
    });
    await expect(
      resolveAuthenticatedFamilyPrincipal(runtime, message),
    ).resolves.toBe(verifiedChildId);
    const verifier = getAuthenticatedRuntimeSpeakerVerifier(runtime);
    if (!verifier) throw new Error("runtime speaker verifier unavailable");
    const issued = await verifier.issueForAuthenticatedMessage(message);
    await expect(verifier.verify(issued.attestation)).resolves.toMatchObject({
      kind: "verified",
      entityId: verifiedChildId,
      matchConfidence: 1,
    });
    await expect(
      verifier.verify({ ...issued.attestation, proof: "tampered-proof" }),
    ).resolves.toEqual({ kind: "unverified", reason: "invalid_proof" });

    const action = createFamilyCommunicationsAction({
      resolveAuthenticatedPrincipal: resolveAuthenticatedFamilyPrincipal,
      issueSpeakerAttestation: issueAuthenticatedMessageSpeakerAttestation,
      resolveWeekItems: resolveTrustedChildWeekItems,
    });
    const result = await action.handler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          action: "capture_voice_bundle",
          candidates: [
            {
              kind: "purchase",
              summary: "Prepare a shoe purchase proposal.",
              subjectEntityIds: [verifiedChildId],
              sourceSpan: { start: 0, end: "buy shoes".length },
            },
          ],
        },
      },
      undefined,
    );
    expect(result).toMatchObject({
      success: true,
      effectReceipts: [
        {
          outcome: "applied",
          operation: "lifeops.family_voice_bundle.capture",
          resource: {
            kind: "lifeops.family_voice_bundle",
          },
          commit: {
            kind: "durable",
          },
        },
      ],
      data: {
        externalEffectsPerformed: false,
        bundle: {
          authorizationState: "authorized",
          principalEntityId: verifiedChildId,
        },
        candidates: [
          {
            kind: "purchase",
            decision: "blocked_scope",
          },
        ],
      },
    });
    expect(result.effectReceipts?.[0]?.resource.id).toBe(
      result.data?.bundle &&
        typeof result.data.bundle === "object" &&
        !Array.isArray(result.data.bundle)
        ? Reflect.get(result.data.bundle, "bundleId")
        : undefined,
    );
  });

  it("rejects entity, platformName, and content-metadata impersonation", async () => {
    const entityOnly = createMessageMemory({
      id: randomUUID() as UUID,
      entityId: verifiedChildId as UUID,
      agentId: runtime.agentId,
      roomId: testRoomId,
      content: {
        text: "buy shoes",
        source: "client_chat",
      },
    });
    entityOnly.worldId = testWorldId;
    await expect(
      resolveAuthenticatedFamilyPrincipal(runtime, entityOnly),
    ).resolves.toBeNull();

    const contentSpoof = createMessageMemory({
      id: randomUUID() as UUID,
      entityId: verifiedChildId as UUID,
      agentId: runtime.agentId,
      roomId: testRoomId,
      content: {
        text: "buy shoes",
        source: "telegram",
        channel: "dm",
        platformName: "telegram",
        metadata: {
          telegram: {
            userId: verifiedHandle,
            messageId: `spoof-${randomUUID()}`,
          },
        },
      },
    });
    contentSpoof.worldId = testWorldId;
    await expect(
      resolveAuthenticatedFamilyPrincipal(runtime, contentSpoof),
    ).resolves.toBeNull();

    const mismatchedEntity = connectorMessage({
      entityId: outsiderId,
      handle: verifiedHandle,
    });
    await expect(
      resolveAuthenticatedFamilyPrincipal(runtime, mismatchedEntity),
    ).resolves.toBeNull();
    await expect(
      getAuthenticatedRuntimeSpeakerVerifier(
        runtime,
      )?.issueForAuthenticatedMessage(mismatchedEntity),
    ).rejects.toMatchObject({
      code: "FAMILY_COMMUNICATIONS_ACCESS_DENIED",
    });
  });

  it.each(["client_chat", "api", "sub_agent"])(
    "rejects the %s provider even when connector-like metadata is present",
    async (provider) => {
      const message = connectorMessage({
        entityId: verifiedChildId,
        handle: verifiedHandle,
        provider,
      });
      await expect(
        resolveAuthenticatedFamilyPrincipal(runtime, message),
      ).resolves.toBeNull();
    },
  );

  it.each(["group", "public"])(
    "rejects a %s channel for non-owner family authentication",
    async (chatType) => {
      const message = connectorMessage({
        entityId: verifiedChildId,
        handle: verifiedHandle,
        chatType,
      });
      await expect(
        resolveAuthenticatedFamilyPrincipal(runtime, message),
      ).resolves.toBeNull();
    },
  );

  it("rejects unverified and ambiguous connector claims before role/scope authorization", async () => {
    const unverified = connectorMessage({
      entityId: unverifiedChildId,
      handle: unverifiedHandle,
    });
    await expect(
      resolveAuthenticatedFamilyPrincipal(runtime, unverified),
    ).resolves.toBeNull();
    const ambiguous = connectorMessage({
      entityId: ambiguousChildOneId,
      handle: ambiguousHandle,
    });
    await expect(
      resolveAuthenticatedFamilyPrincipal(runtime, ambiguous),
    ).resolves.toBeNull();
  });

  it("keeps the owner path role-authenticated and projects only exact child household schedules", async () => {
    const ownerMessage = createMessageMemory({
      id: randomUUID() as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: testRoomId,
      content: { text: "family schedule", source: "client_chat" },
    });
    ownerMessage.worldId = testWorldId;
    await expect(
      resolveAuthenticatedFamilyPrincipal(runtime, ownerMessage),
    ).resolves.toBe(SELF_ENTITY_ID);
    await household.createProposal({
      coordinationId: `family-week-${randomUUID()}`,
      terms: {
        summary: "Private adult-authored pickup details",
        startAt: "2027-03-12T22:00:00.000Z",
        endAt: "2027-03-12T22:30:00.000Z",
        timezone: "America/Los_Angeles",
        childEntityIds: [verifiedChildId],
        location: "Private address",
        notes: "Adult-only handoff notes",
        custodyException: null,
      },
      affectedPartyEntityIds: [verifiedChildId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const items = await resolveTrustedChildWeekItems({
      runtime,
      principalEntityId: verifiedChildId,
      childEntityId: verifiedChildId,
      windowStartsAt: "2027-03-10T00:00:00.000Z",
      windowEndsAt: "2027-03-17T00:00:00.000Z",
      sourceRefs: [HOUSEHOLD_CHILD_WEEK_SOURCE_REF],
    });
    expect(items).toEqual([
      expect.objectContaining({
        kind: "family_logistics",
        title: "Family schedule",
        location: null,
        subjectEntityIds: [verifiedChildId],
        audiencePrincipalEntityIds: [verifiedChildId],
        dataClasses: ["family_logistics"],
      }),
    ]);
    expect(JSON.stringify(items)).not.toContain("Private address");
    expect(JSON.stringify(items)).not.toContain("Adult-only handoff notes");
    await expect(
      resolveTrustedChildWeekItems({
        runtime,
        principalEntityId: verifiedChildId,
        childEntityId: verifiedChildId,
        windowStartsAt: "2027-03-10T00:00:00.000Z",
        windowEndsAt: "2027-03-17T00:00:00.000Z",
        sourceRefs: ["calendar:unclassified-event"],
      }),
    ).rejects.toMatchObject({
      code: "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
    });
  });
});
