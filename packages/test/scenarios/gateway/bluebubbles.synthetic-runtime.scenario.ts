/**
 * Certifies the production BlueBubbles service and connector ingress/egress
 * boundaries against the stateful loopback provider. The scenario is
 * deliberately model-free: it drives runtime transport APIs directly, while
 * live provider qualification remains owned by the #22359 canary.
 */

import {
  type RunningBlueBubblesMock,
  type RunningFetchServer,
  startBlueBubblesMock,
  startFetchServer,
} from "@elizaos/cloud-test-mocks";
import {
  type AgentRuntime,
  createUniqueUuid,
  type Memory,
  type MessageConnectorRegistration,
  type UUID,
} from "@elizaos/core";
import blueBubblesPlugin, {
  BlueBubblesService,
} from "@elizaos/plugin-bluebubbles";
import { scenario } from "@elizaos/scenario-runner/schema";

const CHAT_GUID = "iMessage;-;+14155552671";
const PASSWORD = "scenario-provider-password";
const WEBHOOK_SECRET = "scenario-webhook-secret";
const OUTBOUND_TEXT = "BlueBubbles runtime egress receipt";
const INBOUND_GUID = "scenario-inbound-guid";
const INBOUND_TEXT = "BlueBubbles runtime ingress receipt";

type RuntimeWithMessageService = AgentRuntime & {
  messageService?: unknown;
};

type BoundaryProof = {
  connectors: string[];
  serviceRunning: boolean;
  outbound: {
    source: string;
    chatGuid: string;
    messageGuid: string;
    effectCount: number;
  };
  inbound: {
    source: string;
    messageGuid: string;
    text: string;
    duplicateMemoryCount: number;
  };
  reset: {
    restoredExecutionState: boolean;
    ledgerEntries: number;
  };
};

let provider: RunningBlueBubblesMock | undefined;
let webhookTarget: RunningFetchServer | undefined;
let proof: BoundaryProof | undefined;

function chat() {
  return {
    guid: CHAT_GUID,
    chatIdentifier: "+14155552671",
    displayName: "Scenario Contact",
    participants: [{ address: "+14155552671", service: "iMessage" }],
  };
}

function protocolMessage(): Record<string, unknown> {
  const handle = {
    address: "+14155552671",
    service: "iMessage",
    country: null,
    originalROWID: 1,
    uncanonicalizedId: null,
  };
  return {
    guid: INBOUND_GUID,
    text: INBOUND_TEXT,
    subject: null,
    country: null,
    handle,
    handleId: 1,
    otherHandle: 0,
    chats: [
      {
        ...chat(),
        participants: [handle],
        lastMessage: null,
        style: 45,
        isArchived: false,
        isFiltered: false,
        isPinned: false,
        hasUnreadMessages: false,
      },
    ],
    attachments: [],
    expressiveSendStyleId: null,
    dateCreated: Date.parse("2032-04-05T06:07:08.000Z"),
    dateRead: null,
    dateDelivered: null,
    isFromMe: false,
    isDelayed: false,
    isAutoReply: false,
    isSystemMessage: false,
    isServiceMessage: false,
    isForward: false,
    isArchived: false,
    hasDdResults: false,
    hasPayloadData: false,
    threadOriginatorGuid: null,
    threadOriginatorPart: null,
    associatedMessageGuid: null,
    associatedMessageType: null,
    balloonBundleId: null,
    dateEdited: null,
    error: 0,
    itemType: 0,
    groupTitle: null,
    groupActionType: 0,
    payloadData: null,
  };
}

function unwrapOutboundMemory(value: unknown): Memory {
  if (value && typeof value === "object" && "kind" in value) {
    const result = value as {
      kind?: string;
      memories?: Memory[];
    };
    const memory = result.memories?.[0];
    if (!memory)
      throw new Error(
        `BlueBubbles returned ${result.kind ?? "unknown"} without a memory`,
      );
    return memory;
  }
  if (!value || typeof value !== "object") {
    throw new Error("BlueBubbles runtime egress returned no memory receipt");
  }
  return value as Memory;
}

async function stopLoopbacks(): Promise<void> {
  const results = await Promise.allSettled([
    webhookTarget?.stop(),
    provider?.stop(),
  ]);
  webhookTarget = undefined;
  provider = undefined;
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "BlueBubbles scenario loopback teardown failed",
    );
  }
}

export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  id: "bluebubbles.synthetic-runtime",
  title:
    "BlueBubbles production runtime crosses the synthetic provider boundary",
  domain: "gateway",
  tags: ["gateway", "bluebubbles", "imessage", "mock-provider"],
  description:
    "Boots the real BlueBubbles plugin and service against a resettable loopback provider, then proves connector egress, signed webhook ingress, duplicate suppression, and reset readback without an LLM.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-bluebubbles"],
    services: ["bluebubbles"],
  },
  modelFixtures: {
    mode: "model-free",
    reason:
      "The scenario calls production connector and service boundaries directly.",
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "BlueBubbles Synthetic Runtime",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "boot-bluebubbles-loopback-and-production-service",
      apply: async (ctx) => {
        await stopLoopbacks();
        proof = undefined;
        const runtime = ctx.runtime as RuntimeWithMessageService;
        if (!runtime || !ctx.primaryRoomId) {
          return "BlueBubbles scenario requires a runtime and primary room";
        }

        provider = await startBlueBubblesMock({
          now: () => Date.parse("2032-04-05T06:07:08.000Z"),
          accounts: [
            {
              accountId: "scenario",
              password: PASSWORD,
              chats: [chat()],
            },
          ],
        });
        const initial = await provider.control.snapshot();

        runtime.setSetting("BLUEBUBBLES_SERVER_URL", provider.url);
        runtime.setSetting("BLUEBUBBLES_PASSWORD", PASSWORD, true);
        runtime.setSetting("BLUEBUBBLES_WEBHOOK_SECRET", WEBHOOK_SECRET, true);
        runtime.setSetting("BLUEBUBBLES_DM_POLICY", "open");
        runtime.setSetting("BLUEBUBBLES_SEND_READ_RECEIPTS", "false");
        await runtime.registerPlugin(blueBubblesPlugin);

        const service = runtime.getService<BlueBubblesService>("bluebubbles");
        if (
          !(service instanceof BlueBubblesService) ||
          !service.getIsRunning()
        ) {
          return "production BlueBubblesService did not start against the loopback provider";
        }
        const connectors = runtime
          .getMessageConnectors()
          .map((connector: MessageConnectorRegistration) => connector.source)
          .filter((source) => source === "bluebubbles" || source === "imessage")
          .sort();
        if (connectors.join(",") !== "bluebubbles,imessage") {
          return `expected BlueBubbles and iMessage connectors, saw ${connectors.join(",")}`;
        }

        const outbound = unwrapOutboundMemory(
          await runtime.sendMessageToTarget(
            {
              source: "bluebubbles",
              channelId: "+14155552671",
              roomId: ctx.primaryRoomId as UUID,
            },
            { text: OUTBOUND_TEXT, agentVoiced: true },
          ),
        );
        const outboundMetadata = outbound.metadata as Record<string, unknown>;
        const afterEgress = await provider.control.snapshot();
        const egressLedger = afterEgress.state.ledger as Array<{
          kind: string;
          operation: string;
          outcome: string;
        }>;
        const effectCount = egressLedger.filter(
          (entry) =>
            entry.kind === "effect" &&
            entry.operation === "message.send" &&
            entry.outcome === "succeeded",
        ).length;
        if (effectCount !== 1) {
          return `expected one authoritative message.send effect, saw ${effectCount}`;
        }

        webhookTarget = await startFetchServer(async (request) => {
          if (
            request.headers.get("x-bluebubbles-webhook-secret") !==
            WEBHOOK_SECRET
          ) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
          for (const [name] of request.headers) {
            if (name.startsWith("x-eliza-mock-")) {
              return Response.json(
                { error: "synthetic header leak" },
                { status: 400 },
              );
            }
          }
          const payload = (await request.json()) as {
            type: string;
            data: Record<string, unknown>;
          };
          const messageService = runtime.messageService;
          runtime.messageService = null;
          try {
            await service.handleWebhook(payload);
          } finally {
            runtime.messageService = messageService;
          }
          return Response.json({ accepted: true });
        });
        const webhookUrl = `http://${webhookTarget.hostname}:${webhookTarget.port}/webhooks/bluebubbles`;
        const event = {
          id: "scenario-webhook-event",
          sequence: 1,
          accountId: "scenario",
          type: "new-message" as const,
          data: protocolMessage(),
        };
        const firstDelivery = await provider.deliverWebhook(
          webhookUrl,
          event,
          WEBHOOK_SECRET,
        );
        const duplicateDelivery = await provider.deliverWebhook(
          webhookUrl,
          event,
          WEBHOOK_SECRET,
        );
        if (!firstDelivery[0]?.ok || !duplicateDelivery[0]?.ok) {
          return "signed BlueBubbles webhook delivery was not accepted";
        }

        const inboundId = createUniqueUuid(
          runtime,
          `bluebubbles:${INBOUND_GUID}`,
        ) as UUID;
        const inbound = await runtime.getMemoryById(inboundId);
        if (!inbound || inbound.content.text !== INBOUND_TEXT) {
          return "production BlueBubbles ingress did not persist the exact message";
        }
        const inboundMetadata = inbound.metadata as Record<string, unknown>;
        const duplicateMemoryCount = [
          await runtime.getMemoryById(inboundId),
        ].filter(Boolean).length;

        const reset = await provider.control.reset();
        const resetLedger = reset.state.ledger as unknown[];
        proof = {
          connectors,
          serviceRunning: service.getIsRunning(),
          outbound: {
            source: String(outbound.content.source),
            chatGuid: String(outboundMetadata.bluebubblesChatGuid),
            messageGuid: String(outboundMetadata.bluebubblesMessageGuid),
            effectCount,
          },
          inbound: {
            source: String(inbound.content.source),
            messageGuid: String(inboundMetadata.bluebubblesMessageGuid),
            text: String(inbound.content.text),
            duplicateMemoryCount,
          },
          reset: {
            restoredExecutionState:
              reset.executionStateHash === initial.executionStateHash,
            ledgerEntries: resetLedger.length,
          },
        };
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "wait",
      name: "inspect-bluebubbles-boundary-receipts",
      durationMs: 0,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exact-bluebubbles-service-ingress-egress-receipts",
      predicate: () => {
        const expected = {
          connectors: ["bluebubbles", "imessage"],
          serviceRunning: true,
          outbound: {
            source: "bluebubbles",
            chatGuid: CHAT_GUID,
            effectCount: 1,
          },
          inbound: {
            source: "bluebubbles",
            messageGuid: INBOUND_GUID,
            text: INBOUND_TEXT,
            duplicateMemoryCount: 1,
          },
          reset: { restoredExecutionState: true, ledgerEntries: 0 },
        };
        if (!proof) return "BlueBubbles boundary proof was not captured";
        if (!proof.outbound.messageGuid) {
          return "BlueBubbles egress receipt is missing the provider message GUID";
        }
        const comparable = {
          ...proof,
          outbound: {
            source: proof.outbound.source,
            chatGuid: proof.outbound.chatGuid,
            effectCount: proof.outbound.effectCount,
          },
        };
        if (JSON.stringify(comparable) !== JSON.stringify(expected)) {
          return `unexpected BlueBubbles boundary proof: ${JSON.stringify(proof)}`;
        }
        return undefined;
      },
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "stop-bluebubbles-loopbacks",
      apply: stopLoopbacks,
    },
  ],
});
