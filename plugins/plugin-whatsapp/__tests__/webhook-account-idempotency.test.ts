/**
 * Verifies WhatsApp Cloud API webhook account routing and inbound delivery
 * idempotency with a deterministic mocked runtime and no network access.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppConnectorService } from "../src/runtime-service";

type CloudAccountConfig = {
  accountId: string;
  transport: "cloudapi";
  accessToken: string;
  phoneNumberId: string;
  dmPolicy: "open" | "disabled";
};

function makeRuntime(settings: Record<string, unknown> = {}) {
  const getMemoryById = vi.fn(async (): Promise<Memory | null> => null);
  const createMemory = vi.fn(async () => undefined);
  const ensureConnection = vi.fn(async () => undefined);
  const ensureRoomExists = vi.fn(async () => undefined);
  const handleMessage = vi.fn(async () => undefined);
  const runtime = {
    agentId: "agent-1" as UUID,
    character: { settings },
    getSetting: vi.fn((key: string) =>
      key === "WHATSAPP_AUTO_REPLY" ? false : undefined
    ),
    getMemoryById,
    createMemory,
    ensureConnection,
    ensureRoomExists,
    messageService: { handleMessage },
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  } as never as IAgentRuntime;

  return {
    runtime,
    getMemoryById,
    createMemory,
    ensureConnection,
    ensureRoomExists,
    handleMessage,
  };
}

function cloudAccount(
  accountId: string,
  phoneNumberId: string,
  dmPolicy: "open" | "disabled" = "open"
): CloudAccountConfig {
  return {
    accountId,
    transport: "cloudapi",
    accessToken: `token-${accountId}`,
    phoneNumberId,
    dmPolicy,
  };
}

function configuredService(
  runtime: IAgentRuntime,
  configs: CloudAccountConfig[] = [cloudAccount("default", "phone-default")]
): WhatsAppConnectorService {
  const service = new WhatsAppConnectorService(runtime);
  Object.assign(service, {
    defaultAccountId: "default",
    configs: new Map(configs.map((config) => [config.accountId, config])),
  });
  return service;
}

function webhook(phoneNumberId: string | undefined, messageId = "wamid.1") {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: {
                display_phone_number: "+1 415 555 2671",
                ...(phoneNumberId === undefined ? {} : { phone_number_id: phoneNumberId }),
              },
              messages: [
                {
                  from: "14155552671",
                  id: messageId,
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "hello" },
                },
              ],
            },
          },
        ],
      },
    ],
  } as never;
}

function inflightSize(service: WhatsAppConnectorService): number {
  return (
    service as unknown as {
      inflightInboundMessageIds: Set<string>;
    }
  ).inflightInboundMessageIds.size;
}

describe("WhatsApp Cloud API webhook account routing", () => {
  it("routes messages by metadata.phone_number_id", async () => {
    const { runtime, createMemory } = makeRuntime();
    const service = configuredService(runtime, [
      cloudAccount("default", "phone-default"),
      cloudAccount("work", "phone-work"),
    ]);

    await service.handleWebhook(webhook("phone-work"));

    expect(createMemory).toHaveBeenCalledTimes(1);
    const memory = createMemory.mock.calls[0]?.[0] as Memory;
    expect(memory.metadata).toMatchObject({ accountId: "work" });
  });

  it.each([undefined, "phone-unknown"])(
    "fails closed for a missing or unknown phone number id: %s",
    async (phoneNumberId) => {
      const { runtime, createMemory, ensureConnection, getMemoryById } = makeRuntime();
      const service = configuredService(runtime, [
        cloudAccount("default", "phone-default"),
        cloudAccount("work", "phone-work"),
      ]);

      await service.handleWebhook(webhook(phoneNumberId));

      expect(getMemoryById).not.toHaveBeenCalled();
      expect(ensureConnection).not.toHaveBeenCalled();
      expect(createMemory).not.toHaveBeenCalled();
    }
  );

  it("rejects duplicate Cloud API phone number configuration before connecting", async () => {
    const { runtime } = makeRuntime({
      whatsapp: {
        accounts: {
          alpha: {
            accessToken: "token-alpha",
            phoneNumberId: "phone-shared",
            dmPolicy: "open",
          },
          beta: {
            accessToken: "token-beta",
            phoneNumberId: "phone-shared",
            dmPolicy: "open",
          },
        },
      },
    });
    const service = new WhatsAppConnectorService(runtime);

    await expect(service.initialize()).rejects.toThrow(
      'WhatsApp Cloud API accounts "alpha" and "beta" share the same phone_number_id "phone-shared"'
    );
  });
});

describe("WhatsApp inbound delivery idempotency", () => {
  it("collapses concurrent delivery of the same message", async () => {
    const { runtime, createMemory, getMemoryById } = makeRuntime();
    const service = configuredService(runtime);
    let releaseLookup: (() => void) | undefined;
    const lookupBlocked = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    getMemoryById.mockImplementation(async () => {
      await lookupBlocked;
      return null;
    });

    const first = service.handleWebhook(webhook("phone-default"));
    await vi.waitFor(() => expect(getMemoryById).toHaveBeenCalledTimes(1));
    const duplicate = service.handleWebhook(webhook("phone-default"));

    expect(getMemoryById).toHaveBeenCalledTimes(1);
    releaseLookup?.();
    await Promise.all([first, duplicate]);

    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(inflightSize(service)).toBe(0);
  });

  it("skips durable duplicates and clears the in-flight key after each return", async () => {
    const { runtime, createMemory, getMemoryById } = makeRuntime();
    const service = configuredService(runtime);
    getMemoryById.mockResolvedValue({ id: "existing-memory" as UUID } as Memory);

    await service.handleWebhook(webhook("phone-default"));
    await service.handleWebhook(webhook("phone-default"));

    expect(getMemoryById).toHaveBeenCalledTimes(2);
    expect(createMemory).not.toHaveBeenCalled();
    expect(inflightSize(service)).toBe(0);
  });

  it("propagates storage-check failures and clears the in-flight key for retry", async () => {
    const { runtime, createMemory, ensureConnection, getMemoryById } = makeRuntime();
    const service = configuredService(runtime);
    getMemoryById.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(service.handleWebhook(webhook("phone-default"))).rejects.toThrow(
      "storage unavailable"
    );
    expect(ensureConnection).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
    expect(inflightSize(service)).toBe(0);

    getMemoryById.mockResolvedValue(null);
    await service.handleWebhook(webhook("phone-default"));

    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(inflightSize(service)).toBe(0);
  });

  it("clears the in-flight key after policy-denied returns", async () => {
    const { runtime, createMemory, getMemoryById } = makeRuntime();
    const service = configuredService(runtime, [
      cloudAccount("default", "phone-default", "disabled"),
    ]);

    await service.handleWebhook(webhook("phone-default"));
    await service.handleWebhook(webhook("phone-default"));

    expect(getMemoryById).toHaveBeenCalledTimes(2);
    expect(createMemory).not.toHaveBeenCalled();
    expect(inflightSize(service)).toBe(0);
  });

  it("clears the in-flight key after processing errors", async () => {
    const { runtime, createMemory } = makeRuntime();
    const service = configuredService(runtime);
    createMemory.mockRejectedValueOnce(new Error("write failed"));

    await expect(service.handleWebhook(webhook("phone-default"))).rejects.toThrow("write failed");
    expect(inflightSize(service)).toBe(0);

    await service.handleWebhook(webhook("phone-default"));

    expect(createMemory).toHaveBeenCalledTimes(2);
    expect(inflightSize(service)).toBe(0);
  });
});
