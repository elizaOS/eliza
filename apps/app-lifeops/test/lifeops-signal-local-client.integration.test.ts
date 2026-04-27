/**
 * Integration test: Signal local client reader via `signal-local-client.ts`.
 *
 * Tests the direct signal-cli HTTP API reader that activates when
 * `SIGNAL_HTTP_URL` + `SIGNAL_ACCOUNT_NUMBER` are set but the full
 * `@elizaos/plugin-signal` service is not connected.
 *
 * Gating:
 * - Stub-based tests run without any live credentials.
 * - Live tests gate on `SIGNAL_HTTP_URL` being set to a real daemon.
 * - Set `SKIP_REASON` to skip all tests with a documented reason.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itIf } from "../../../../test/helpers/conditional-tests.ts";
import {
  readSignalInboundMessages,
  readSignalLocalClientConfigFromEnv,
  SignalLocalClientError,
  type SignalLocalClientConfig,
} from "../src/lifeops/signal-local-client.js";

const SKIP_REASON = process.env.SKIP_REASON?.trim();
const LIVE_SIGNAL_HTTP_URL = process.env.SIGNAL_HTTP_URL?.trim();
const LIVE_SIGNAL_ACCOUNT = process.env.SIGNAL_ACCOUNT_NUMBER?.trim();
const LIVE_AVAILABLE =
  !SKIP_REASON &&
  Boolean(LIVE_SIGNAL_HTTP_URL) &&
  Boolean(LIVE_SIGNAL_ACCOUNT);

// ---------------------------------------------------------------------------
// HTTP stub
// ---------------------------------------------------------------------------

type StubServer = {
  close: () => Promise<void>;
  port: number;
  baseUrl: string;
};

function makeReceivePayload(
  messages: Array<{
    source: string;
    sourceName: string;
    message: string;
    timestamp: number;
    groupId?: string;
  }>,
) {
  return messages.map((m) => ({
    envelope: {
      source: m.source,
      sourceNumber: m.source,
      sourceName: m.sourceName,
      timestamp: m.timestamp,
      dataMessage: {
        timestamp: m.timestamp,
        message: m.message,
        ...(m.groupId
          ? { groupInfo: { groupId: m.groupId, type: "UPDATE" } }
          : {}),
      },
    },
    account: "+15550000000",
  }));
}

async function startSignalStub(
  messages: Parameters<typeof makeReceivePayload>[0],
): Promise<StubServer> {
  const server = createServer(
    (_req: IncomingMessage, res: ServerResponse) => {
      const payload = makeReceivePayload(messages);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve stub port");
  }

  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("signal-local-client: readSignalLocalClientConfigFromEnv", () => {
  let savedHttpUrl: string | undefined;
  let savedAccount: string | undefined;

  beforeEach(() => {
    savedHttpUrl = process.env.SIGNAL_HTTP_URL;
    savedAccount = process.env.SIGNAL_ACCOUNT_NUMBER;
    delete process.env.SIGNAL_HTTP_URL;
    delete process.env.SIGNAL_ACCOUNT_NUMBER;
  });

  afterEach(() => {
    if (savedHttpUrl === undefined) delete process.env.SIGNAL_HTTP_URL;
    else process.env.SIGNAL_HTTP_URL = savedHttpUrl;
    if (savedAccount === undefined) delete process.env.SIGNAL_ACCOUNT_NUMBER;
    else process.env.SIGNAL_ACCOUNT_NUMBER = savedAccount;
  });

  it("returns null when SIGNAL_HTTP_URL is absent", () => {
    process.env.SIGNAL_ACCOUNT_NUMBER = "+15550000000";
    const config = readSignalLocalClientConfigFromEnv(process.env);
    expect(config).toBeNull();
  });

  it("returns null when SIGNAL_ACCOUNT_NUMBER is absent", () => {
    process.env.SIGNAL_HTTP_URL = "http://localhost:8080";
    const config = readSignalLocalClientConfigFromEnv(process.env);
    expect(config).toBeNull();
  });

  it("returns config when both vars are set", () => {
    process.env.SIGNAL_HTTP_URL = "http://localhost:8080";
    process.env.SIGNAL_ACCOUNT_NUMBER = "+15550000000";
    const config = readSignalLocalClientConfigFromEnv(process.env);
    expect(config).not.toBeNull();
    expect(config?.httpUrl).toBe("http://localhost:8080");
    expect(config?.accountNumber).toBe("+15550000000");
  });
});

describe("signal-local-client: readSignalInboundMessages (stub)", () => {
  let stub: StubServer | undefined;

  afterEach(async () => {
    if (stub) {
      await stub.close();
      stub = undefined;
    }
  });

  it("throws when daemon is unreachable", async () => {
    const config: SignalLocalClientConfig = {
      httpUrl: "http://127.0.0.1:19999", // nothing listening here
      accountNumber: "+15550000000",
    };
    await expect(readSignalInboundMessages(config)).rejects.toMatchObject({
      name: "SignalLocalClientError",
      category: "network",
      status: null,
    });
  });

  it("returns empty array when stub returns empty JSON array", async () => {
    stub = await startSignalStub([]);
    const config: SignalLocalClientConfig = {
      httpUrl: stub.baseUrl,
      accountNumber: "+15550000000",
    };
    const messages = await readSignalInboundMessages(config);
    expect(messages).toEqual([]);
  });

  it("parses a single inbound text message", async () => {
    const timestamp = Date.now();
    stub = await startSignalStub([
      {
        source: "+15551110001",
        sourceName: "Alice",
        message: "Hello from Signal",
        timestamp,
      },
    ]);
    const config: SignalLocalClientConfig = {
      httpUrl: stub.baseUrl,
      accountNumber: "+15550000000",
    };
    const messages = await readSignalInboundMessages(config);
    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(typeof msg.id).toBe("string");
    expect(msg.id).toContain("+15551110001");
    expect(msg.speakerName).toBe("Alice");
    expect(msg.text).toBe("Hello from Signal");
    expect(msg.createdAt).toBe(timestamp);
    expect(msg.isInbound).toBe(true);
    expect(msg.isGroup).toBe(false);
    expect(msg.channelId).toBe("+15551110001");
    expect(msg.threadId).toBe("+15551110001");
    expect(msg.roomName).toBe("Alice");
    expect(msg.senderNumber).toBe("+15551110001");
    expect(msg.senderUuid).toBeNull();
    expect(msg.sourceDevice).toBeNull();
    expect(msg.groupId).toBeNull();
    expect(msg.groupType).toBeNull();
  });

  it("parses a group message with groupId as channelId", async () => {
    const timestamp = Date.now();
    stub = await startSignalStub([
      {
        source: "+15551110001",
        sourceName: "Bob",
        message: "Group message",
        timestamp,
        groupId: "group-abc-123",
      },
    ]);
    const config: SignalLocalClientConfig = {
      httpUrl: stub.baseUrl,
      accountNumber: "+15550000000",
    };
    const messages = await readSignalInboundMessages(config);
    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.isGroup).toBe(true);
    expect(msg.channelId).toBe("group-abc-123");
    expect(msg.threadId).toBe("group-abc-123");
    expect(msg.roomName).toBe("Signal group group-abc-123");
    expect(msg.senderNumber).toBe("+15551110001");
    expect(msg.groupId).toBe("group-abc-123");
    expect(msg.groupType).toBe("UPDATE");
    expect(msg.text).toBe("Group message");
  });

  it("respects the limit parameter", async () => {
    const ts = Date.now();
    stub = await startSignalStub([
      { source: "+15551110001", sourceName: "A", message: "msg1", timestamp: ts },
      { source: "+15551110002", sourceName: "B", message: "msg2", timestamp: ts + 1 },
      { source: "+15551110003", sourceName: "C", message: "msg3", timestamp: ts + 2 },
    ]);
    const config: SignalLocalClientConfig = {
      httpUrl: stub.baseUrl,
      accountNumber: "+15550000000",
    };
    const messages = await readSignalInboundMessages(config, 2);
    expect(messages).toHaveLength(2);
  });

  it("all returned messages have the required LifeOpsSignalInboundMessage fields", async () => {
    const ts = Date.now();
    stub = await startSignalStub([
      { source: "+15551110001", sourceName: "Carol", message: "Hi", timestamp: ts },
    ]);
    const config: SignalLocalClientConfig = {
      httpUrl: stub.baseUrl,
      accountNumber: "+15550000000",
    };
    const messages = await readSignalInboundMessages(config);
    for (const msg of messages) {
      expect(typeof msg.id).toBe("string");
      expect(msg.id.length).toBeGreaterThan(0);
      expect(typeof msg.roomId).toBe("string");
      expect(typeof msg.channelId).toBe("string");
      expect(typeof msg.threadId).toBe("string");
      expect(typeof msg.roomName).toBe("string");
      expect(typeof msg.speakerName).toBe("string");
      expect(
        msg.senderNumber === null || typeof msg.senderNumber === "string",
      ).toBe(true);
      expect(msg.senderUuid === null || typeof msg.senderUuid === "string").toBe(
        true,
      );
      expect(
        msg.sourceDevice === null || typeof msg.sourceDevice === "number",
      ).toBe(true);
      expect(msg.groupId === null || typeof msg.groupId === "string").toBe(true);
      expect(msg.groupType === null || typeof msg.groupType === "string").toBe(
        true,
      );
      expect(typeof msg.text).toBe("string");
      expect(typeof msg.createdAt).toBe("number");
      expect(typeof msg.isInbound).toBe("boolean");
      expect(typeof msg.isGroup).toBe("boolean");
    }
  });

  it("throws SignalLocalClientError when the daemon returns HTTP failure", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "daemon exploded" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve stub port");
    }
    stub = {
      port: address.port,
      baseUrl: `http://127.0.0.1:${address.port}`,
      close: async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      },
    };

    const config: SignalLocalClientConfig = {
      httpUrl: stub.baseUrl,
      accountNumber: "+15550000000",
    };

    await expect(readSignalInboundMessages(config)).rejects.toBeInstanceOf(
      SignalLocalClientError,
    );
    await expect(readSignalInboundMessages(config)).rejects.toMatchObject({
      status: 500,
      category: "unknown",
    });
  });
});

describe("signal-local-client: readSignalInboundMessages (live)", () => {
  itIf(LIVE_AVAILABLE)(
    "reads messages from a live signal-cli daemon",
    async () => {
      const config: SignalLocalClientConfig = {
        httpUrl: LIVE_SIGNAL_HTTP_URL!,
        accountNumber: LIVE_SIGNAL_ACCOUNT!,
      };
      const messages = await readSignalInboundMessages(config, 10);
      expect(Array.isArray(messages)).toBe(true);
      for (const msg of messages) {
        expect(typeof msg.id).toBe("string");
        expect(typeof msg.text).toBe("string");
        expect(typeof msg.isInbound).toBe("boolean");
        expect(msg.isInbound).toBe(true);
      }
    },
    20_000,
  );
});
