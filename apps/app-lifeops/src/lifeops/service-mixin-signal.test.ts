import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSignal } from "./service-mixin-signal.js";

const ORIGINAL_ENV = {
  ELIZA_OAUTH_DIR: process.env.ELIZA_OAUTH_DIR,
  SIGNAL_ACCOUNT_NUMBER: process.env.SIGNAL_ACCOUNT_NUMBER,
  SIGNAL_AUTH_DIR: process.env.SIGNAL_AUTH_DIR,
  SIGNAL_HTTP_URL: process.env.SIGNAL_HTTP_URL,
};
const ORIGINAL_FETCH = globalThis.fetch;
let tmpDir: string;

class StubBase {
  runtime: {
    agentId: string;
    getService: ReturnType<typeof vi.fn>;
    setSetting: ReturnType<typeof vi.fn>;
  };
  ownerEntityId = null;
  repository = {
    deleteConnectorGrant: vi.fn(),
    getConnectorGrant: vi.fn(),
    upsertConnectorGrant: vi.fn(),
  };

  constructor(signalService: unknown = null) {
    this.runtime = {
      agentId: "agent-signal",
      getService: vi.fn((serviceType: string) =>
        serviceType === "signal" ? signalService : null,
      ),
      setSetting: vi.fn(),
    };
  }

  agentId(): string {
    return this.runtime.agentId;
  }
}

type SignalConsumer = {
  getSignalConnectorStatus: (side?: "owner" | "agent") => Promise<{
    connected: boolean;
    inbound: boolean;
    reason: string;
    grantedCapabilities: string[];
  }>;
  readSignalInbound: (limit?: number) => Promise<
    Array<{
      id: string;
      roomId: string;
      channelId: string;
      threadId: string;
      roomName: string;
      speakerName: string;
      senderNumber: string | null;
      senderUuid: string | null;
      sourceDevice: number | null;
      groupId: string | null;
      groupType: string | null;
      text: string;
      createdAt: number;
      isInbound: boolean;
      isGroup: boolean;
    }>
  >;
};

const Composed = withSignal(StubBase as never);

function createService(
  signalService: unknown = null,
): StubBase & SignalConsumer {
  return new (
    Composed as unknown as new (
      signalService?: unknown,
    ) => StubBase & SignalConsumer
  )(signalService);
}

describe("withSignal consumer surface", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-signal-"));
    process.env.ELIZA_OAUTH_DIR = tmpDir;
    delete process.env.SIGNAL_AUTH_DIR;
    delete process.env.SIGNAL_ACCOUNT_NUMBER;
    delete process.env.SIGNAL_HTTP_URL;
    globalThis.fetch = ORIGINAL_FETCH;
  });

  afterEach(() => {
    if (ORIGINAL_ENV.ELIZA_OAUTH_DIR === undefined) {
      delete process.env.ELIZA_OAUTH_DIR;
    } else {
      process.env.ELIZA_OAUTH_DIR = ORIGINAL_ENV.ELIZA_OAUTH_DIR;
    }
    if (ORIGINAL_ENV.SIGNAL_AUTH_DIR === undefined) {
      delete process.env.SIGNAL_AUTH_DIR;
    } else {
      process.env.SIGNAL_AUTH_DIR = ORIGINAL_ENV.SIGNAL_AUTH_DIR;
    }
    if (ORIGINAL_ENV.SIGNAL_ACCOUNT_NUMBER === undefined) {
      delete process.env.SIGNAL_ACCOUNT_NUMBER;
    } else {
      process.env.SIGNAL_ACCOUNT_NUMBER = ORIGINAL_ENV.SIGNAL_ACCOUNT_NUMBER;
    }
    if (ORIGINAL_ENV.SIGNAL_HTTP_URL === undefined) {
      delete process.env.SIGNAL_HTTP_URL;
    } else {
      process.env.SIGNAL_HTTP_URL = ORIGINAL_ENV.SIGNAL_HTTP_URL;
    }
    globalThis.fetch = ORIGINAL_FETCH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reports disconnected status when no grant or pairing exists", async () => {
    const service = createService();
    service.repository.getConnectorGrant.mockResolvedValue(null);

    const status = await service.getSignalConnectorStatus("owner");

    expect(status.connected).toBe(false);
    expect(status.inbound).toBe(false);
    expect(status.reason).toBe("disconnected");
  });

  it("adopts the only linked device for the requested side when the grant is missing", async () => {
    const previousAuthDir = path.join(
      tmpDir,
      "lifeops",
      "signal",
      "agent-previous",
      "owner",
    );
    fs.mkdirSync(previousAuthDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(previousAuthDir, "device-info.json"),
      JSON.stringify(
        {
          authDir: previousAuthDir,
          phoneNumber: "+15550000000",
          uuid: "signal-uuid",
          deviceName: "Milady Mac",
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );
    const service = createService();
    service.repository.getConnectorGrant.mockResolvedValue(null);

    const status = await service.getSignalConnectorStatus("owner");

    expect(status.connected).toBe(true);
    expect(status.inbound).toBe(true);
    expect(status.reason).toBe("connected");
    expect(service.repository.upsertConnectorGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-signal",
        provider: "signal",
        side: "owner",
        tokenRef: previousAuthDir,
        capabilities: ["signal.read", "signal.send"],
        identity: expect.objectContaining({
          phoneNumber: "+15550000000",
          uuid: "signal-uuid",
        }),
        metadata: expect.objectContaining({
          adoptedFromAgentId: "agent-previous",
        }),
      }),
    );
    expect(process.env.SIGNAL_AUTH_DIR).toBe(previousAuthDir);
    expect(process.env.SIGNAL_ACCOUNT_NUMBER).toBe("+15550000000");
    expect(service.runtime.setSetting).toHaveBeenCalledWith(
      "SIGNAL_RECEIVE_MODE",
      "manual",
      false,
    );
    expect(service.runtime.setSetting).toHaveBeenCalledWith(
      "SIGNAL_AUTO_REPLY",
      "false",
      false,
    );
  });

  it("upgrades existing linked Signal grants to bidirectional capabilities", async () => {
    const authDir = path.join(
      tmpDir,
      "lifeops",
      "signal",
      "agent-signal",
      "owner",
    );
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(authDir, "device-info.json"),
      JSON.stringify({
        authDir,
        phoneNumber: "+15550000000",
        uuid: "signal-uuid",
        deviceName: "Milady Mac",
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const existingGrant = {
      id: "grant-1",
      agentId: "agent-signal",
      provider: "signal",
      side: "owner",
      identity: { phoneNumber: "+15550000000" },
      grantedScopes: [],
      capabilities: ["signal.read"],
      tokenRef: authDir,
      mode: "local",
      executionTarget: "local",
      sourceOfTruth: "local_storage",
      preferredByAgent: false,
      cloudConnectionId: null,
      metadata: {},
      lastRefreshAt: "2026-04-27T00:00:00.000Z",
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    const service = createService();
    service.repository.getConnectorGrant.mockResolvedValue(existingGrant);

    const status = await service.getSignalConnectorStatus("owner");

    expect(status.connected).toBe(true);
    expect(status.grantedCapabilities).toEqual(["signal.read", "signal.send"]);
    expect(service.repository.upsertConnectorGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "grant-1",
        capabilities: ["signal.read", "signal.send"],
      }),
    );
  });

  it("reads recent inbound messages from the connected Signal service", async () => {
    const signalService = {
      isServiceConnected: vi.fn(() => true),
      getRecentMessages: vi.fn(async () => [
        {
          id: "signal-service-1",
          roomId: "room-1",
          channelId: "+15551110001",
          roomName: "Alice",
          speakerName: "Alice",
          text: "Dinner at 7?",
          createdAt: 1_713_340_800_000,
          isFromAgent: false,
          isGroup: false,
        },
      ]),
    };
    const service = createService(signalService);

    await expect(service.readSignalInbound(5)).resolves.toEqual([
      {
        id: "signal-service-1",
        roomId: "room-1",
        channelId: "+15551110001",
        threadId: "+15551110001",
        roomName: "Alice",
        speakerName: "Alice",
        senderNumber: "+15551110001",
        senderUuid: null,
        sourceDevice: null,
        groupId: null,
        groupType: null,
        text: "Dinner at 7?",
        createdAt: 1_713_340_800_000,
        isInbound: true,
        isGroup: false,
      },
    ]);
    expect(signalService.getRecentMessages).toHaveBeenCalledWith(5);
  });

  it("falls back to signal-cli HTTP receive when the plugin service is absent", async () => {
    process.env.SIGNAL_HTTP_URL = "http://127.0.0.1:9000";
    process.env.SIGNAL_ACCOUNT_NUMBER = "+15550000000";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "http://127.0.0.1:9000/v1/receive/%2B15550000000",
      );
      return new Response(
        JSON.stringify([
          {
            envelope: {
              sourceNumber: "+15551110002",
              sourceName: "Bob",
              sourceUuid: "9f5e7ab0-fb18-4a87-a013-4a792de778dd",
              sourceDevice: 2,
              timestamp: 1_713_340_900_000,
              dataMessage: {
                timestamp: 1_713_340_900_000,
                message: "Signal fallback",
                groupInfo: { groupId: "group-signal-1", type: "DELIVER" },
              },
            },
            account: "+15550000000",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const service = createService();

    await expect(service.readSignalInbound(10)).resolves.toEqual([
      {
        id: "signal:+15551110002:1713340900000",
        roomId: "group-signal-1",
        channelId: "group-signal-1",
        threadId: "group-signal-1",
        roomName: "Signal group group-signal-1",
        speakerName: "Bob",
        senderNumber: "+15551110002",
        senderUuid: "9f5e7ab0-fb18-4a87-a013-4a792de778dd",
        sourceDevice: 2,
        groupId: "group-signal-1",
        groupType: "DELIVER",
        text: "Signal fallback",
        createdAt: 1_713_340_900_000,
        isInbound: true,
        isGroup: true,
      },
    ]);
  });

  it("falls back to signal-cli HTTP receive when the connected service has no buffered messages", async () => {
    process.env.SIGNAL_ACCOUNT_NUMBER = "+15550000000";
    const signalService = {
      isServiceConnected: vi.fn(() => true),
      getRecentMessages: vi.fn(async () => []),
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "http://127.0.0.1:8080/v1/receive/%2B15550000000",
      );
      return new Response(
        JSON.stringify([
          {
            envelope: {
              sourceNumber: "+15551110003",
              sourceName: "Casey",
              sourceDevice: 1,
              timestamp: 1_713_341_000_000,
              dataMessage: {
                timestamp: 1_713_341_000_000,
                message: "Passive pull",
              },
            },
            account: "+15550000000",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const service = createService(signalService);

    await expect(service.readSignalInbound(10)).resolves.toEqual([
      {
        id: "signal:+15551110003:1713341000000",
        roomId: "+15551110003",
        channelId: "+15551110003",
        threadId: "+15551110003",
        roomName: "Casey",
        speakerName: "Casey",
        senderNumber: "+15551110003",
        senderUuid: null,
        sourceDevice: 1,
        groupId: null,
        groupType: null,
        text: "Passive pull",
        createdAt: 1_713_341_000_000,
        isInbound: true,
        isGroup: false,
      },
    ]);
    expect(signalService.getRecentMessages).toHaveBeenCalledWith(10);
  });

  it("surfaces signal-cli receive failures instead of returning an empty success", async () => {
    process.env.SIGNAL_HTTP_URL = "http://127.0.0.1:9000";
    process.env.SIGNAL_ACCOUNT_NUMBER = "+15550000000";
    globalThis.fetch = vi.fn(
      async () => new Response("broken", { status: 503 }),
    ) as unknown as typeof fetch;
    const service = createService();

    await expect(service.readSignalInbound(10)).rejects.toThrow(
      "Signal local receive failed with HTTP 503",
    );
  });
});
