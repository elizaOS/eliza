/**
 * Exercises Blooio webhook idempotency through the public service boundary with
 * a durable runtime cache and a controlled inbound dispatcher. The harness
 * proves failed dispatches remain retryable, concurrent deliveries cannot both
 * dispatch, and completed receipts survive a new service instance.
 */

import crypto from "node:crypto";
import type { IAgentRuntime, Media } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ChatDbMessage } from "./chatdb-reader.js";
import { IMessageService } from "./service.js";
import type { IMessageSettings } from "./types.js";

const SECRET = "whsec_dedupe_test";
const CHANNEL_ID = "ch_bettina";
const MESSAGE_ID = "msg_retry_1";

function envelope(): string {
  return JSON.stringify({
    id: "evt_retry_1",
    type: "message.received",
    created_at: Date.now(),
    data: {
      id: MESSAGE_ID,
      chat_id: "chat_retry_1",
      channel_id: CHANNEL_ID,
      channel_type: "blooio",
      sender: "+15551234567",
      recipient: "+12692921765",
      text: "retry me safely",
    },
  });
}

function sign(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = crypto.createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

interface CacheHarness {
  runtime: IAgentRuntime;
  store: Map<string, unknown>;
  reportError: ReturnType<typeof vi.fn>;
}

function makeRuntime(store = new Map<string, unknown>()): CacheHarness {
  const reportError = vi.fn();
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: vi.fn(() => undefined),
    getCache: vi.fn(async (key: string) => store.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return true;
    }),
    reportError,
  } as unknown as IAgentRuntime;
  return { runtime, store, reportError };
}

type InboundDispatch = (row: ChatDbMessage, media?: Media[]) => Promise<void>;

function makeService(runtime: IAgentRuntime, dispatch: InboundDispatch): IMessageService {
  const service = new IMessageService(runtime);
  const internal = service as unknown as {
    settings: IMessageSettings;
    dispatchInboundMessage: InboundDispatch;
  };
  internal.settings = {
    transport: "blooio",
    pollIntervalMs: 0,
    heartbeatIntervalMs: 60_000,
    dmPolicy: "open",
    groupPolicy: "allowlist",
    allowFrom: [],
    enabled: true,
    blooioApiKey: "api_test",
    blooioWebhookSecret: SECRET,
    blooioFromNumber: "+12692921765",
    blooioChannelId: CHANNEL_ID,
  };
  internal.dispatchInboundMessage = dispatch;
  return service;
}

describe("Blooio webhook durable dispatch receipts", () => {
  it("leaves no receipt after dispatch failure so a provider retry can succeed", async () => {
    const { runtime, store } = makeRuntime();
    const dispatch = vi
      .fn<InboundDispatch>()
      .mockRejectedValueOnce(new Error("runtime temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    const service = makeService(runtime, dispatch);
    const body = envelope();
    const signature = sign(body);

    await expect(service.handleBlooioWebhook(body, signature)).rejects.toThrow(
      "runtime temporarily unavailable"
    );
    expect(store.size).toBe(0);

    await expect(service.handleBlooioWebhook(body, signature)).resolves.toBe("accepted");
    await expect(service.handleBlooioWebhook(body, signature)).resolves.toBe("ignored");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(1);
    const [receiptKey] = store.keys();
    expect(receiptKey).toMatch(/^imessage:blooio-receipt:v1:[a-f0-9]{64}$/);
    expect(receiptKey).not.toContain(CHANNEL_ID);
    expect(receiptKey).not.toContain(MESSAGE_ID);
  });

  it("rejects a concurrent duplicate without dispatching it twice", async () => {
    const { runtime, reportError } = makeRuntime();
    let releaseDispatch: (() => void) | undefined;
    const dispatchBlocked = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const dispatch = vi.fn<InboundDispatch>(() => dispatchBlocked);
    const service = makeService(runtime, dispatch);
    const body = envelope();
    const signature = sign(body);

    const first = service.handleBlooioWebhook(body, signature);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    await expect(service.handleBlooioWebhook(body, signature)).rejects.toMatchObject({
      code: "IMESSAGE_BLOOIO_DISPATCH_IN_FLIGHT",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      "IMessageService.blooioWebhook",
      expect.objectContaining({ code: "IMESSAGE_BLOOIO_DISPATCH_IN_FLIGHT" }),
      expect.objectContaining({ receiptDigest: expect.any(String) })
    );

    releaseDispatch?.();
    await expect(first).resolves.toBe("accepted");
    await expect(service.handleBlooioWebhook(body, signature)).resolves.toBe("ignored");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("uses the durable receipt to suppress replay after a new service instance starts", async () => {
    const sharedStore = new Map<string, unknown>();
    const firstHarness = makeRuntime(sharedStore);
    const firstDispatch = vi.fn<InboundDispatch>().mockResolvedValue(undefined);
    const firstService = makeService(firstHarness.runtime, firstDispatch);
    const body = envelope();
    const signature = sign(body);

    await expect(firstService.handleBlooioWebhook(body, signature)).resolves.toBe("accepted");

    const restartedHarness = makeRuntime(sharedStore);
    const restartedDispatch = vi.fn<InboundDispatch>().mockResolvedValue(undefined);
    const restartedService = makeService(restartedHarness.runtime, restartedDispatch);
    await expect(restartedService.handleBlooioWebhook(body, signature)).resolves.toBe("ignored");
    expect(firstDispatch).toHaveBeenCalledTimes(1);
    expect(restartedDispatch).not.toHaveBeenCalled();
  });

  it("reports and fails before dispatch when durable receipt storage is unavailable", async () => {
    const { runtime, reportError } = makeRuntime();
    vi.mocked(runtime.getCache).mockRejectedValueOnce(new Error("cache offline"));
    const dispatch = vi.fn<InboundDispatch>().mockResolvedValue(undefined);
    const service = makeService(runtime, dispatch);
    const body = envelope();

    await expect(service.handleBlooioWebhook(body, sign(body))).rejects.toMatchObject({
      code: "IMESSAGE_BLOOIO_RECEIPT_READ_FAILED",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      "IMessageService.blooioWebhook",
      expect.objectContaining({ code: "IMESSAGE_BLOOIO_RECEIPT_READ_FAILED" }),
      expect.objectContaining({ receiptDigest: expect.any(String) })
    );
  });
});
