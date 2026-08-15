/**
 * Exercises the real GatewayManager DM boundary with deterministic routing adapters.
 * Both route topologies and live assignment refresh use the production manager methods.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "discord.js";
import {
  type DiscordConnectionDmMetadata,
  type DiscordConnectionDmPolicyState,
  parseDiscordConnectionDmPolicyState,
} from "../src/dm-policy";
import { GatewayManager } from "../src/gateway-manager";

const CONNECTION_ID = "connection-1";
const OWNER = "111111111111111111";
const FRIEND = "222222222222222222";
const STRANGER = "999999999999999999";

interface HarnessConnection {
  connectionId: string;
  organizationId: string;
  applicationId: string;
  characterId: string;
  client: unknown;
  status: "connected";
  guildCount: number;
  eventsReceived: number;
  eventsRouted: number;
  eventsFailed: number;
  consecutiveFailures: number;
  lastHeartbeat: Date;
  listeners: Map<string, unknown>;
  dmPolicyState: DiscordConnectionDmPolicyState;
}

interface GatewayManagerHarness {
  connections: Map<string, HarnessConnection>;
  redis: object | null;
  accessToken: string | null;
  handleMessage(connectionId: string, message: Message): Promise<void>;
  pollForBots(): Promise<void>;
  voiceHandler: {
    processVoiceAttachments(): Promise<unknown[]>;
  };
}

type Topology = "in-worker" | "dedicated";

function valid(
  metadata: DiscordConnectionDmMetadata,
): DiscordConnectionDmPolicyState {
  return { status: "valid", metadata };
}

function messageFrom(authorId: string): Message {
  return {
    id: `message-${authorId}`,
    channelId: "dm-channel",
    guildId: null,
    author: {
      id: authorId,
      username: "sender",
      discriminator: "0",
      avatar: null,
      bot: false,
      globalName: "Sender",
    },
    member: null,
    content: "hello",
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
    attachments: [],
    embeds: [],
    mentions: { users: [] },
    reference: null,
    channel: {},
    flags: null,
  } as unknown as Message;
}

function createBoundary(topology: Topology) {
  const calls = {
    resolve: 0,
    inWorker: 0,
    dedicated: 0,
    assignmentFetch: 0,
  };
  let assignments: unknown[] = [];
  const manager = new GatewayManager(
    {
      podName: "test-pod",
      elizaCloudUrl: "https://cloud.test",
      gatewayBootstrapSecret: "test-secret",
      project: "test",
    },
    {
      resolveAgentServer: async () => {
        calls.resolve += 1;
        return topology === "dedicated"
          ? { serverName: "agent-server", serverUrl: "http://agent.test" }
          : null;
      },
      refreshKedaActivity: async () => {},
      forwardToServer: async () => {
        calls.dedicated += 1;
        return "";
      },
      fetchAssignments: async () => {
        calls.assignmentFetch += 1;
        return new Response(JSON.stringify({ assignments }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      forwardInWorkerEvent: async () => {
        calls.inWorker += 1;
        return new Response(null, { status: 200 });
      },
    },
  );
  const harness = manager as unknown as GatewayManagerHarness;
  harness.redis = {};
  harness.accessToken = "test-token";

  return {
    harness,
    calls,
    setAssignments(value: unknown[]) {
      assignments = value;
    },
  };
}

function seedConnection(
  harness: GatewayManagerHarness,
  state: DiscordConnectionDmPolicyState,
  client: unknown = {},
): HarnessConnection {
  const connection: HarnessConnection = {
    connectionId: CONNECTION_ID,
    organizationId: "organization-1",
    applicationId: "application-1",
    characterId: "character-1",
    client,
    status: "connected",
    guildCount: 0,
    eventsReceived: 0,
    eventsRouted: 0,
    eventsFailed: 0,
    consecutiveFailures: 0,
    lastHeartbeat: new Date("2026-08-15T00:00:00.000Z"),
    listeners: new Map(),
    dmPolicyState: state,
  };
  harness.connections.set(CONNECTION_ID, connection);
  return connection;
}

const previousVoiceSetting = process.env.VOICE_MESSAGE_ENABLED;

beforeEach(() => {
  process.env.VOICE_MESSAGE_ENABLED = "false";
});

afterEach(() => {
  if (previousVoiceSetting === undefined) {
    delete process.env.VOICE_MESSAGE_ENABLED;
  } else {
    process.env.VOICE_MESSAGE_ENABLED = previousVoiceSetting;
  }
});

const cases: Array<{
  name: string;
  state: DiscordConnectionDmPolicyState;
  authorId: string;
  routed: boolean;
}> = [
  { name: "open stranger", state: valid({}), authorId: STRANGER, routed: true },
  {
    name: "disabled owner",
    state: valid({ dmPolicy: "disabled", ownerDiscordUserId: OWNER }),
    authorId: OWNER,
    routed: false,
  },
  {
    name: "allowlist owner",
    state: valid({ dmPolicy: "allowlist", ownerDiscordUserId: OWNER }),
    authorId: OWNER,
    routed: true,
  },
  {
    name: "allowlist configured sender",
    state: valid({ dmPolicy: "allowlist", dmAllowFrom: [FRIEND] }),
    authorId: FRIEND,
    routed: true,
  },
  {
    name: "allowlist stranger",
    state: valid({ dmPolicy: "allowlist", dmAllowFrom: [FRIEND] }),
    authorId: STRANGER,
    routed: false,
  },
  {
    name: "pairing owner",
    state: valid({ dmPolicy: "pairing", ownerDiscordUserIds: [OWNER] }),
    authorId: OWNER,
    routed: true,
  },
  {
    name: "pairing allowlist-only sender",
    state: valid({ dmPolicy: "pairing", dmAllowFrom: [FRIEND] }),
    authorId: FRIEND,
    routed: false,
  },
  {
    name: "malformed restrictive metadata",
    state: parseDiscordConnectionDmPolicyState({
      status: "valid",
      metadata: { dmPolicy: "allowlist", dmAllowFrom: ["bad"] },
    }),
    authorId: OWNER,
    routed: false,
  },
];

for (const topology of ["in-worker", "dedicated"] as const) {
  describe(`GatewayManager ${topology} DM boundary`, () => {
    test.each(cases)("enforces $name", async ({ state, authorId, routed }) => {
      const { harness, calls } = createBoundary(topology);
      seedConnection(harness, state);

      await harness.handleMessage(CONNECTION_ID, messageFrom(authorId));

      expect(calls.resolve).toBe(routed ? 1 : 0);
      expect(calls.inWorker).toBe(routed && topology === "in-worker" ? 1 : 0);
      expect(calls.dedicated).toBe(routed && topology === "dedicated" ? 1 : 0);
    });
  });
}

test("rejects a denied voice DM before processing its attachment", async () => {
  process.env.VOICE_MESSAGE_ENABLED = "true";
  const { harness, calls } = createBoundary("dedicated");
  let voiceProcessingCalls = 0;
  harness.voiceHandler = {
    processVoiceAttachments: async () => {
      voiceProcessingCalls += 1;
      return [];
    },
  };
  seedConnection(harness, valid({ dmPolicy: "disabled" }));
  const message = messageFrom(STRANGER);
  (message as unknown as { attachments: unknown[] }).attachments = [
    {
      id: "voice-attachment",
      name: "voice-message.ogg",
      contentType: "audio/ogg",
      size: 128,
      url: "https://cdn.discord.test/voice-message.ogg",
    },
  ];

  await harness.handleMessage(CONNECTION_ID, message);

  expect(voiceProcessingCalls).toBe(0);
  expect(calls.resolve).toBe(0);
  expect(calls.inWorker).toBe(0);
  expect(calls.dedicated).toBe(0);
});

test("refreshes restrictive metadata on an existing bot without reconnecting", async () => {
  const { harness, calls, setAssignments } = createBoundary("dedicated");
  const client = { marker: "same-discord-client" };
  const existing = seedConnection(harness, valid({}), client);
  setAssignments([
    {
      connectionId: CONNECTION_ID,
      organizationId: "organization-1",
      applicationId: "application-1",
      botToken: "unused-for-existing-connection",
      intents: 0,
      characterId: "character-1",
      dmPolicyState: {
        status: "valid",
        metadata: { dmPolicy: "disabled" },
      },
    },
  ]);

  await harness.pollForBots();

  const refreshed = harness.connections.get(CONNECTION_ID);
  expect(refreshed).toBe(existing);
  expect(refreshed?.client).toBe(client);
  expect(refreshed?.dmPolicyState).toEqual({
    status: "valid",
    metadata: { dmPolicy: "disabled" },
  });

  await harness.handleMessage(CONNECTION_ID, messageFrom(OWNER));
  expect(calls.assignmentFetch).toBe(1);
  expect(calls.resolve).toBe(0);
  expect(calls.dedicated).toBe(0);
});
