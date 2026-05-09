import type {
  RelationshipsGraphService,
  RelationshipsPersonDetail,
  RelationshipsPersonSummary,
} from "@elizaos/core";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

type RelationshipsServiceLike = {
  addContact: (
    entityId: UUID,
    categories?: string[],
    preferences?: Record<string, unknown>,
    customFields?: Record<string, unknown>,
  ) => Promise<unknown>;
  upsertIdentity: (
    entityId: UUID,
    identity: {
      platform: string;
      handle: string;
      confidence?: number;
      verified?: boolean;
      source?: string;
    },
    evidenceMessageIds?: UUID[],
  ) => Promise<void>;
  proposeMerge: (
    entityA: UUID,
    entityB: UUID,
    evidence: Record<string, unknown>,
  ) => Promise<UUID>;
  acceptMerge: (candidateId: UUID) => Promise<void>;
};

type RelationshipsFeatureRuntime = AgentRuntime & {
  enableRelationships?: () => Promise<void>;
  isRelationshipsEnabled?: () => boolean;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
};

export const CANONICAL_IDENTITY_PLATFORMS = [
  "gmail",
  "signal",
  "telegram",
  "whatsapp",
] as const;

export type CanonicalIdentityPlatform =
  (typeof CANONICAL_IDENTITY_PLATFORMS)[number];

export type SeededCanonicalIdentityContact = {
  entityId: UUID;
  roomId: UUID;
  worldId: UUID;
  platform: CanonicalIdentityPlatform;
  handle: string;
  inboundMessageId: UUID;
  outboundMessageId: UUID;
  inboundText: string;
};

export type SeededCanonicalIdentityFixture = {
  seedKey: string;
  ownerId: UUID;
  ownerName: string;
  personName: string;
  primaryPlatform: CanonicalIdentityPlatform;
  primaryEntityId: UUID;
  contacts: Record<CanonicalIdentityPlatform, SeededCanonicalIdentityContact>;
};

const PLATFORM_FIXTURES: Record<
  CanonicalIdentityPlatform,
  { handle: string; inboundText: string; outboundText: string }
> = {
  gmail: {
    handle: "priya.rao@example.com",
    inboundText:
      "Gmail: Priya Rao sent the investor packet and wants feedback before noon.",
    outboundText:
      "I saw the investor packet, Priya. I will send comments before lunch.",
  },
  signal: {
    handle: "+14155550101",
    inboundText:
      "Signal: Priya Rao says the contractor can call after 4pm today.",
    outboundText: "Thanks. Tell the contractor I am free after 4pm Pacific.",
  },
  telegram: {
    handle: "@priya_rao",
    inboundText:
      "Telegram: Priya Rao moved the dinner reservation to 7:30 tonight.",
    outboundText:
      "7:30 works. Send me the updated reservation details when you have them.",
  },
  whatsapp: {
    handle: "+447700900123",
    inboundText:
      "WhatsApp: Priya Rao confirmed the London car pickup at Heathrow.",
    outboundText:
      "Perfect. Please send the driver contact when it is available.",
  },
};

function makeScopedUuid(seedKey: string, label: string): UUID {
  return stringToUuid(`identity-merge:${seedKey}:${label}`) as UUID;
}

async function ensureEntity(
  runtime: AgentRuntime,
  entityId: UUID,
  name: string,
): Promise<void> {
  const existing = await runtime.getEntityById(entityId);
  if (existing) {
    return;
  }
  await runtime.createEntity({
    id: entityId,
    names: [name],
    agentId: runtime.agentId,
  });
}

async function ensureDirectRoom(args: {
  runtime: AgentRuntime;
  entityId: UUID;
  roomId: UUID;
  worldId: UUID;
  source: string;
  channelId: string;
  userName: string;
}): Promise<void> {
  await args.runtime.ensureWorldExists({
    id: args.worldId,
    name: `${args.source}-world`,
    agentId: args.runtime.agentId,
  } as Parameters<typeof args.runtime.ensureWorldExists>[0]);

  await args.runtime.ensureConnection({
    entityId: args.entityId,
    roomId: args.roomId,
    worldId: args.worldId,
    userName: args.userName,
    name: args.userName,
    source: args.source,
    channelId: args.channelId,
    type: ChannelType.DM,
  });

  await args.runtime.ensureParticipantInRoom(args.runtime.agentId, args.roomId);
  await args.runtime.ensureParticipantInRoom(args.entityId, args.roomId);
}

async function resolveRelationshipsService(
  runtime: AgentRuntime,
): Promise<RelationshipsServiceLike> {
  const featureRuntime = runtime as RelationshipsFeatureRuntime;
  if (
    typeof featureRuntime.isRelationshipsEnabled === "function" &&
    !featureRuntime.isRelationshipsEnabled() &&
    typeof featureRuntime.enableRelationships === "function"
  ) {
    await featureRuntime.enableRelationships();
  }

  const fromLoadPromise =
    typeof featureRuntime.getServiceLoadPromise === "function"
      ? await featureRuntime.getServiceLoadPromise("relationships")
      : null;
  const service =
    (fromLoadPromise as RelationshipsServiceLike | null) ??
    (runtime.getService("relationships") as RelationshipsServiceLike | null);
  if (!service) {
    throw new Error("relationships service unavailable");
  }
  return service;
}

export async function seedCanonicalIdentityFixture(args: {
  runtime: AgentRuntime;
  seedKey: string;
  ownerId?: UUID;
  ownerName?: string;
  personName?: string;
  primaryPlatform?: CanonicalIdentityPlatform;
}): Promise<SeededCanonicalIdentityFixture> {
  const runtime = args.runtime;
  const relationships = await resolveRelationshipsService(runtime);
  const seedKey = args.seedKey;
  const ownerId = args.ownerId ?? makeScopedUuid(seedKey, "owner");
  const ownerName = args.ownerName ?? "Shaw";
  const personName = args.personName ?? "Priya Rao";
  const primaryPlatform = args.primaryPlatform ?? "gmail";

  await ensureEntity(runtime, ownerId, ownerName);

  const contacts = {} as Record<
    CanonicalIdentityPlatform,
    SeededCanonicalIdentityContact
  >;

  for (const platform of CANONICAL_IDENTITY_PLATFORMS) {
    const entityId = makeScopedUuid(seedKey, `${platform}:entity`);
    const roomId = makeScopedUuid(seedKey, `${platform}:room`);
    const worldId = makeScopedUuid(seedKey, `${platform}:world`);
    const inboundMessageId = makeScopedUuid(seedKey, `${platform}:inbound`);
    const outboundMessageId = makeScopedUuid(seedKey, `${platform}:outbound`);
    const fixture = PLATFORM_FIXTURES[platform];

    await ensureEntity(runtime, entityId, personName);
    await relationships.addContact(
      entityId,
      ["contact"],
      { preferredCommunicationChannel: platform },
      {
        canonicalName: personName,
        sourcePlatform: platform,
      },
    );
    await ensureDirectRoom({
      runtime,
      entityId,
      roomId,
      worldId,
      source: platform,
      channelId: `${platform}-${seedKey}`,
      userName: personName,
    });

    await runtime.createMemory(
      createMessageMemory({
        id: inboundMessageId,
        entityId,
        roomId,
        content: {
          text: fixture.inboundText,
          source: platform,
          channelType: ChannelType.DM,
        },
      }),
      "messages",
    );
    await runtime.createMemory(
      createMessageMemory({
        id: outboundMessageId,
        entityId: ownerId,
        roomId,
        content: {
          text: fixture.outboundText,
          source: platform,
          channelType: ChannelType.DM,
        },
      }),
      "messages",
    );
    await runtime.createRelationship({
      sourceEntityId: ownerId,
      targetEntityId: entityId,
      tags: ["conversation", "direct_exchange"],
      metadata: {
        source: "identity-merge-test-fixture",
        status: "confirmed",
      },
    });

    await relationships.upsertIdentity(
      entityId,
      {
        platform,
        handle: fixture.handle,
        confidence: 0.95,
        verified: true,
        source: "identity-merge-test-fixture",
      },
      [inboundMessageId],
    );

    contacts[platform] = {
      entityId,
      roomId,
      worldId,
      platform,
      handle: fixture.handle,
      inboundMessageId,
      outboundMessageId,
      inboundText: fixture.inboundText,
    };
  }

  return {
    seedKey,
    ownerId,
    ownerName,
    personName,
    primaryPlatform,
    primaryEntityId: contacts[primaryPlatform].entityId,
    contacts,
  };
}

export async function acceptCanonicalIdentityMerge(
  runtime: AgentRuntime,
  fixture: SeededCanonicalIdentityFixture,
): Promise<void> {
  const relationships = await resolveRelationshipsService(runtime);
  for (const platform of CANONICAL_IDENTITY_PLATFORMS) {
    if (platform === fixture.primaryPlatform) {
      continue;
    }
    const candidateId = await relationships.proposeMerge(
      fixture.primaryEntityId,
      fixture.contacts[platform].entityId,
      {
        source: "identity-merge-test-fixture",
        confidence: 1,
        notes: `${fixture.personName} is the same person across ${fixture.primaryPlatform} and ${platform}`,
      },
    );
    await relationships.acceptMerge(candidateId);
  }
}

export async function getCanonicalIdentityGraph(
  runtime: AgentRuntime,
): Promise<RelationshipsGraphService> {
  const graph = runtime.getService(
    "relationships",
  ) as unknown as RelationshipsGraphService | null;
  if (!graph) {
    throw new Error("relationships graph service unavailable");
  }
  return graph;
}

export async function findCanonicalPerson(
  runtime: AgentRuntime,
  personName: string,
): Promise<RelationshipsPersonSummary | null> {
  const graph = await getCanonicalIdentityGraph(runtime);
  const snapshot = await graph.getGraphSnapshot({
    search: personName,
    limit: 10,
  });
  return snapshot.people[0] ?? null;
}

export async function getCanonicalPersonDetail(
  runtime: AgentRuntime,
  personName: string,
): Promise<RelationshipsPersonDetail | null> {
  const graph = await getCanonicalIdentityGraph(runtime);
  const person = await findCanonicalPerson(runtime, personName);
  if (!person) {
    return null;
  }
  return graph.getPersonDetail(person.primaryEntityId);
}

export async function assertCanonicalIdentityMerged(args: {
  runtime: AgentRuntime;
  personName: string;
  expectedPlatforms?: readonly CanonicalIdentityPlatform[];
  expectedMembers?: number;
}): Promise<string | undefined> {
  const detail = await getCanonicalPersonDetail(args.runtime, args.personName);
  if (!detail) {
    return `Expected canonical person "${args.personName}" but none was found.`;
  }

  const expectedPlatforms =
    args.expectedPlatforms ?? CANONICAL_IDENTITY_PLATFORMS;
  const expectedMembers = args.expectedMembers ?? expectedPlatforms.length;
  if (detail.memberEntityIds.length !== expectedMembers) {
    return `Expected "${args.personName}" to have ${expectedMembers} merged identities, saw ${detail.memberEntityIds.length}.`;
  }

  if (detail.identities.length !== expectedMembers) {
    return `Expected "${args.personName}" detail to expose ${expectedMembers} identity summaries, saw ${detail.identities.length}.`;
  }

  if (detail.identityEdges.length < expectedMembers - 1) {
    return `Expected "${args.personName}" to retain ${expectedMembers - 1} confirmed identity links, saw ${detail.identityEdges.length}.`;
  }

  if (detail.recentConversations.length < expectedPlatforms.length) {
    return `Expected "${args.personName}" to retain ${expectedPlatforms.length} recent cross-platform conversations, saw ${detail.recentConversations.length}.`;
  }

  const transcript = detail.recentConversations
    .flatMap((conversation) =>
      conversation.messages.map((message) => message.text),
    )
    .join("\n")
    .toLowerCase();
  for (const platform of expectedPlatforms) {
    if (!transcript.includes(platform)) {
      return `Expected "${args.personName}" conversation history to include ${platform}, but it was missing from the merged transcript.`;
    }
  }

  return undefined;
}
