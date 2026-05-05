import type {
  IAgentRuntime,
  Memory,
  MessageConnector,
  UUID,
} from "@elizaos/core";
import { parseToonKeyValue } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceState = vi.hoisted(() => ({
  instances: [] as Array<{
    getTelegramConnectorStatus: ReturnType<typeof vi.fn>;
    sendTelegramMessage: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("./lifeops-google-helpers.js", () => ({
  INTERNAL_URL: new URL("http://127.0.0.1/"),
  hasLifeOpsAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent/security/access", () => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent/actions/extract-params", () => ({
  extractActionParamsViaLlm: vi.fn(
    async (args: { existingParams: unknown }) => args.existingParams,
  ),
}));

vi.mock("../lifeops/service.js", () => {
  class FakeLifeOpsService {
    getTelegramConnectorStatus = vi.fn(async () => ({
      provider: "telegram",
      connected: false,
    }));
    sendTelegramMessage = vi.fn(async () => ({ ok: true }));

    constructor() {
      serviceState.instances.push(this);
    }
  }

  class FakeLifeOpsServiceError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }

  return {
    LifeOpsService: FakeLifeOpsService,
    LifeOpsServiceError: FakeLifeOpsServiceError,
  };
});

vi.mock("../lifeops/cross-channel-search.js", () => ({
  CROSS_CHANNEL_SEARCH_CHANNELS: [
    "gmail",
    "memory",
    "telegram",
    "discord",
    "imessage",
    "whatsapp",
    "signal",
    "x",
    "x-dm",
    "calendly",
    "calendar",
  ],
  runCrossChannelSearch: vi.fn(async () => ({
    query: "Frontier Tower",
    hits: [
      {
        channel: "gmail",
        id: "gm-1",
        sourceRef: "gm-1",
        timestamp: "2026-05-05T12:00:00.000Z",
        speaker: "alice@example.com",
        subject: "Frontier Tower",
        text: "Frontier Tower budget details and follow-up notes.",
        citation: {
          platform: "gmail",
          label: "Frontier Tower",
          url: "https://mail.test/gm-1",
        },
      },
    ],
    unsupported: [],
    degraded: [],
    channelsWithHits: ["gmail"],
    resolvedPerson: null,
  })),
}));

import { crossChannelSendAction } from "./cross-channel-send.js";
import { lifeOpsConnectorAction } from "./lifeops-connector.js";
import { crossChannelContextProvider } from "../providers/cross-channel-context.js";

const ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-000000000002" as UUID;

function makeMessage(text = "send a telegram"): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000003" as UUID,
    roomId: ROOM_ID,
    entityId: ENTITY_ID,
    content: { text },
  } as Memory;
}

function telegramConnector(): MessageConnector {
  return {
    source: "telegram",
    label: "Telegram",
    capabilities: ["send_message"],
    supportedTargetKinds: ["channel", "user"],
    contexts: ["social", "connectors"],
    description: "Telegram connector",
  };
}

function makeRuntime(
  connectors: MessageConnector[] = [telegramConnector()],
): IAgentRuntime & {
  getMessageConnectors: ReturnType<typeof vi.fn>;
  sendMessageToTarget: ReturnType<typeof vi.fn>;
} {
  return {
    agentId: "00000000-0000-0000-0000-000000000004" as UUID,
    character: { name: "Test Agent" },
    getMessageConnectors: vi.fn(() => connectors),
    sendMessageToTarget: vi.fn(async () => undefined),
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime & {
    getMessageConnectors: ReturnType<typeof vi.fn>;
    sendMessageToTarget: ReturnType<typeof vi.fn>;
  };
}

describe("LifeOps router compression B", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceState.instances.length = 0;
  });

  it("delegates registered chat sends through SEND_MESSAGE instead of LifeOps direct send methods", async () => {
    const runtime = makeRuntime();
    const handler = crossChannelSendAction.handler;
    if (!handler) {
      throw new Error("crossChannelSendAction.handler is missing");
    }

    const result = await handler(runtime, makeMessage(), undefined, {
      parameters: {
        channel: "telegram",
        target: "alice",
        message: "on my way",
        confirmed: true,
      },
    });

    expect(result?.success).toBe(true);
    expect(runtime.sendMessageToTarget).toHaveBeenCalledWith(
      { source: "telegram", channelId: "alice" },
      expect.objectContaining({ text: "on my way", source: "telegram" }),
    );
    const service = serviceState.instances.at(-1);
    expect(service).toBeDefined();
    expect(service?.sendTelegramMessage).not.toHaveBeenCalled();
    expect(result?.data).toMatchObject({
      actionName: "OWNER_SEND_MESSAGE",
      result: { routedBy: "SEND_MESSAGE", source: "telegram" },
    });
  });

  it("reads registered connector status from the core connector registry", async () => {
    const runtime = makeRuntime();
    const handler = lifeOpsConnectorAction.handler;
    if (!handler) {
      throw new Error("lifeOpsConnectorAction.handler is missing");
    }

    const result = await handler(
      runtime,
      makeMessage("telegram status"),
      undefined,
      {
        parameters: { connector: "telegram", subaction: "status" },
      },
    );

    expect(result?.success).toBe(true);
    const service = serviceState.instances.at(-1);
    expect(service).toBeDefined();
    expect(service?.getTelegramConnectorStatus).not.toHaveBeenCalled();
    expect(result?.data).toMatchObject({
      actionName: "LIFEOPS_CONNECTOR",
      connector: "telegram",
      statusSource: "core_message_connector_registry",
      status: {
        source: "telegram",
        registered: true,
      },
    });
  });

  it("renders cross-channel provider context as TOON", async () => {
    const result = await crossChannelContextProvider.get(
      makeRuntime(),
      makeMessage("brief me on Frontier Tower"),
      {
        crossChannelContextRequest: {
          query: "Frontier Tower",
          limit: 3,
        },
      } as never,
    );

    expect(result.text).toContain("cross_channel_context");
    expect(result.text).not.toContain("Cross-channel context for");
    const parsed = parseToonKeyValue<Record<string, unknown>>(result.text);
    expect(parsed?.cross_channel_context).toMatchObject({
      query: "Frontier Tower",
      hitCount: 1,
    });
  });
});
