/**
 * CONNECTOR action emits the in-chat `[CONFIG:<pluginId>]` setup-card marker on
 * `connect` for each chat-set-up connector (discord, telegram, imessage,
 * whatsapp, wechat) when the connector is not yet connected, and
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
  startGoogleConnector: vi.fn(),
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
  class LifeOpsServiceError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.name = "LifeOpsServiceError";
      this.status = status;
      this.code = code;
    }
  }
  return {
    LifeOpsService: class LifeOpsService {
      getDiscordConnectorStatus = vi.fn(async () => status());
      getTelegramConnectorStatus = vi.fn(async () => status());
      getIMessageConnectorStatus = vi.fn(async () => status());
      getWhatsAppConnectorStatus = vi.fn(async () => status());
      startGoogleConnector = mocks.startGoogleConnector;
    },
    LifeOpsServiceError,
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
  mocks.startGoogleConnector.mockReset();
});

describe("CONNECTOR Google connect handoff cards", () => {
  it("pins trusted Google OAuth URLs as verified user-facing text", async () => {
    mocks.startGoogleConnector.mockResolvedValue({
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
      mode: "local",
      side: "owner",
    });
    const result = await connect("google");
    expect(result.success).toBe(true);
    expect(result.verifiedUserFacing).toBe(true);
    expect(result.userFacingText).toContain(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
    );
    expect(result.text).toContain(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
    );
    expect(result.data).toMatchObject({
      awaitingUserAction: true,
      awaitingUserInput: true,
    });
  });

  it("refuses untrusted OAuth URL hosts", async () => {
    mocks.startGoogleConnector.mockResolvedValue({
      authUrl: "https://evil.example/phish",
      mode: "local",
      side: "owner",
    });
    const result = await connect("google");
    expect(result.success).toBe(false);
    expect(result.verifiedUserFacing).not.toBe(true);
    expect(result.data).toMatchObject({ error: "GOOGLE_AUTH_URL_UNTRUSTED" });
  });

  it("fails closed when authUrl is missing", async () => {
    mocks.startGoogleConnector.mockResolvedValue({
      authUrl: "",
      mode: "local",
      side: "owner",
    });
    const result = await connect("google");
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "GOOGLE_AUTH_URL_MISSING" });
  });

  it("validate rejects calendar-feed connect phrasing", async () => {
    await expect(
      connectorAction.validate?.(
        {} as never,
        { content: { text: "connect google calendar" } } as never,
      ),
    ).resolves.toBe(false);
    await expect(
      connectorAction.validate?.(
        {} as never,
        { content: { text: "link my microsoft cal" } } as never,
      ),
    ).resolves.toBe(false);
    await expect(
      connectorAction.validate?.(
        {} as never,
        { content: { text: "connect my gmail" } } as never,
      ),
    ).resolves.toBe(true);
    // Whole-word boundaries: calculation/call must not trip the calendar gate.
    await expect(
      connectorAction.validate?.(
        {} as never,
        { content: { text: "add a note about the calculation" } } as never,
      ),
    ).resolves.toBe(true);
    await expect(
      connectorAction.validate?.(
        {} as never,
        { content: { text: "connect the support call" } } as never,
      ),
    ).resolves.toBe(true);
  });

  it("emits a verified [CONFIG:google-workspace] card with sanitized copy when OAuth cannot start", async () => {
    const { LifeOpsServiceError } = await import("../src/lifeops/service.js");
    mocks.startGoogleConnector.mockRejectedValue(
      new LifeOpsServiceError(
        503,
        "@elizaos/plugin-google-workspace is required before starting Google OAuth. internal-debug=xyz",
      ),
    );
    const result = await connect("google");
    expect(result.success).toBe(false);
    expect(result.verifiedUserFacing).toBe(true);
    expect(result.text).toContain("[CONFIG:google-workspace]");
    expect(result.userFacingText).toContain("[CONFIG:google-workspace]");
    // Must not leak raw upstream / internal error text into verified UI copy.
    expect(result.text).not.toContain("internal-debug");
    expect(result.userFacingText).toMatch(
      /Google Workspace enabled and OAuth configured/i,
    );
    expect(result.data).toMatchObject({
      awaitingUserAction: true,
      status: 503,
    });
  });

  it("maps incomplete GOOGLE_CLIENT_* Error to google-workspace setup card", async () => {
    mocks.startGoogleConnector.mockRejectedValue(
      new Error(
        "Google OAuth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to be configured.",
      ),
    );
    const result = await connect("google");
    expect(result.success).toBe(false);
    expect(result.verifiedUserFacing).toBe(true);
    expect(result.text).toContain("[CONFIG:google-workspace]");
    expect(result.data).toMatchObject({
      error: "GOOGLE_OAUTH_CONFIG_INCOMPLETE",
    });
  });

  it("routes calendar-feed connect away from CONNECTOR in metadata", () => {
    expect(connectorAction.routingHint).toMatch(/CALENDAR_SOURCES/);
    expect(connectorAction.routingHint).toMatch(/calendar/i);
    expect(connectorAction.description).toMatch(/CALENDAR_SOURCES/);
    expect(connectorAction.contexts).not.toContain("calendar");
  });
});

describe("CONNECTOR connect emits the setup-card marker", () => {
  it.each([
    ["discord", "[CONFIG:discord]"],
    ["telegram", "[CONFIG:telegram]"],
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
