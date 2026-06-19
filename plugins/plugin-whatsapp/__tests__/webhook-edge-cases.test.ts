import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppConnectorService } from "../src/runtime-service";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    character: { settings: {} },
    getSetting: vi.fn(() => undefined),
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  } as never as IAgentRuntime;
}

describe("WhatsApp webhook payload edge cases", () => {
  it.each([
    null,
    {},
    { entry: null },
    { entry: [{ changes: null }] },
    { entry: [{ changes: [{ value: null }] }] },
    { entry: [{ changes: [{ value: { metadata: null, messages: [{ id: "m1" }] } }] }] },
  ])("ignores malformed webhook payloads without throwing %#", async (payload) => {
    const service = new WhatsAppConnectorService(makeRuntime());

    await expect(service.handleWebhook(payload as never)).resolves.toBeUndefined();
  });

  it("records display phone metadata even when messages are absent", async () => {
    const service = new WhatsAppConnectorService(makeRuntime());

    await service.handleWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: {
                  display_phone_number: "+1 415 555 2671",
                  phone_number_id: "phone-id",
                },
              },
            },
          ],
        },
      ],
    } as never);

    expect(service.phoneNumber).toBe("+1 415 555 2671");
  });

  it("skips message objects missing required sender or message id", async () => {
    const runtime = makeRuntime();
    const service = new WhatsAppConnectorService(runtime);

    await expect(
      service.handleWebhook({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: {},
                  messages: [
                    { id: "missing-from", timestamp: "1", text: { body: "hello" } },
                    { from: "14155552671", timestamp: "1", text: { body: "hello" } },
                  ],
                },
              },
            ],
          },
        ],
      } as never)
    ).resolves.toBeUndefined();
  });
});
