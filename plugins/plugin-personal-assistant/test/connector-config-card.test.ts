/**
 * CONNECTOR action emits the in-chat `[CONFIG:<pluginId>]` setup-card marker on
 * `connect` for each chat-set-up connector (discord, telegram, signal,
 * imessage, whatsapp, wechat) when the connector is not yet connected, and
 * omits it once the connector reports connected. The UI parses this marker into
 * the InlinePluginConfig widget (packages/ui message-parser-helpers), so this
 * is the server half of "set up <connector> in chat → a setup widget".
 *
 * Deterministic: the LLM param extractor, access gate, and LifeOpsService
 * status probes are mocked so the test drives the real dispatcher branches.
 */

import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  extractActionParamsViaLlm: vi.fn(),
  hasLifeOpsAccess: vi.fn(async () => true),
  connected: { value: false },
}));

vi.mock("@elizaos/agent", () => ({
  extractActionParamsViaLlm: mocks.extractActionParamsViaLlm,
}));

vi.mock("../src/lifeops/access.js", () => ({
  hasLifeOpsAccess: mocks.hasLifeOpsAccess,
  INTERNAL_URL: new URL("http://127.0.0.1/"),
}));

vi.mock("../src/lifeops/connectors/index.js", () => ({
  // No core message-connector registry and no ConnectorRegistry contribution,
  // so the dispatchers fall through to the LifeOpsService status probe below —
  // the path that emits the config card.
  getConnectorRegistry: vi.fn(() => null),
}));

// A LifeOpsService whose per-connector status probes report the scripted
// `mocks.connected` flag. Every connector's `getXConnectorStatus` returns the
// same shape, which is all the connect dispatchers read.
vi.mock("../src/lifeops/service.js", () => {
  const status = () => ({ connected: mocks.connected.value });
  return {
    LifeOpsService: class LifeOpsService {
      getDiscordConnectorStatus = vi.fn(async () => status());
      getTelegramConnectorStatus = vi.fn(async () => status());
      getSignalConnectorStatus = vi.fn(async () => status());
      getIMessageConnectorStatus = vi.fn(async () => status());
      getWhatsAppConnectorStatus = vi.fn(async () => status());
    },
    LifeOpsServiceError: class LifeOpsServiceError extends Error {
      status = 500;
    },
  };
});

vi.mock("../src/platform/host.js", () => ({
  darwinUnavailableActionResult: vi.fn(() => ({
    success: false,
    data: { error: "DARWIN_UNAVAILABLE" },
  })),
  isDarwin: vi.fn(() => true),
}));

import { connectorAction } from "../src/actions/connector.js";

function runtime(): IAgentRuntime {
  return {
    agentId: "agent-connector-card-test" as UUID,
    getMessageConnectors: () => [],
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  } as unknown as IAgentRuntime;
}

async function connect(connector: string): Promise<ActionResult> {
  mocks.extractActionParamsViaLlm.mockResolvedValue({
    action: "connect",
    connector,
  });
  const result = await connectorAction.handler(
    runtime(),
    {
      id: "m" as UUID,
      entityId: "owner" as UUID,
      roomId: "r" as UUID,
      content: { text: `set up ${connector}`, action: "connect", connector },
    } as Memory,
    { values: {}, data: {}, text: "" } as State,
    { parameters: { action: "connect", connector } } as HandlerOptions,
    async () => undefined,
  );
  return result as ActionResult;
}

beforeEach(() => {
  mocks.extractActionParamsViaLlm.mockReset();
  mocks.hasLifeOpsAccess.mockReset().mockResolvedValue(true);
  mocks.connected.value = false;
});

describe("CONNECTOR connect emits the setup-card marker", () => {
  it.each([
    ["discord", "[CONFIG:discord]"],
    ["telegram", "[CONFIG:telegram]"],
    ["signal", "[CONFIG:signal]"],
    ["imessage", "[CONFIG:imessage]"],
    ["whatsapp", "[CONFIG:whatsapp]"],
    ["wechat", "[CONFIG:wechat]"],
  ])("%s connect (not connected) carries %s", async (connector, marker) => {
    const result = await connect(connector);
    expect(result.text).toContain(marker);
  });

  it("omits the marker for a connector that is already connected", async () => {
    mocks.connected.value = true;
    const result = await connect("discord");
    expect(result.text).not.toContain("[CONFIG:");
    expect(result.success).toBe(true);
  });
});
