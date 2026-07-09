/**
 * Connector-event coverage for delegation contracts.
 *
 * Real connector-shaped memories prove transport metadata reaches the existing
 * durable delegation processor without teaching connectors LifeOps policy.
 */
import type { IAgentRuntime, Memory, MessagePayload } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

const listDelegationContracts = vi.fn(async () => []);

vi.mock("../src/lifeops/repository.js", () => ({
  LifeOpsRepository: class {
    listDelegationContracts = listDelegationContracts;
    upsertDelegationContract = vi.fn(async () => undefined);
  },
}));

vi.mock("../src/lifeops/approval-queue.js", () => ({
  createApprovalQueue: vi.fn(() => ({
    enqueue: vi.fn(),
  })),
}));

import {
  delegationInboundTurnFromMessage,
  handleDelegationInboundMessage,
} from "../src/lifeops/delegation-contracts/inbound-event.js";

const ENTITY_ID = "00000000-0000-0000-0000-000000001856";
const ROOM_ID = "00000000-0000-0000-0000-000000001857";

function message(overrides: Partial<Memory> = {}): Memory {
  return {
    entityId: ENTITY_ID,
    roomId: ROOM_ID,
    createdAt: Date.parse("2026-07-09T18:00:00.000Z"),
    content: { text: "The price is too high; procurement needs a discount." },
    metadata: {
      type: "message",
      source: "telegram",
      sender: { id: "vendor-1", name: "Riley Vendor" },
      telegram: {
        userId: "vendor-1",
        chatId: "vendor-chat",
        threadId: "renewal-thread",
      },
    },
    ...overrides,
  } as Memory;
}

describe("delegation connector event normalization", () => {
  it("maps a Telegram topic to its contract thread", () => {
    expect(delegationInboundTurnFromMessage(message())).toEqual({
      channel: "telegram",
      threadId: "renewal-thread",
      sender: "Riley Vendor",
      text: "The price is too high; procurement needs a discount.",
      receivedAt: "2026-07-09T18:00:00.000Z",
    });
  });

  it("maps Gmail aliases and sender-class metadata for SLA contracts", () => {
    expect(
      delegationInboundTurnFromMessage(
        message({
          content: {
            text: "Can you send the latest numbers?",
            source: "gmail",
            metadata: {
              senderEmail: "dana@board.example",
              senderClass: "board_member",
              subject: "Quarterly update",
              threadId: "thread-board-1",
            },
          },
          metadata: { type: "message", source: "gmail" },
        }),
      ),
    ).toEqual({
      channel: "email",
      threadId: "thread-board-1",
      sender: ENTITY_ID,
      senderEmail: "dana@board.example",
      senderClass: "board_member",
      subject: "Quarterly update",
      text: "Can you send the latest numbers?",
      receivedAt: "2026-07-09T18:00:00.000Z",
    });
  });

  it("ignores in-app messages that cannot match connector contracts", () => {
    expect(
      delegationInboundTurnFromMessage(
        message({
          content: { text: "hello", source: "client_chat" },
          metadata: { type: "message", source: "client_chat" },
        }),
      ),
    ).toBeNull();
  });

  it("hands connector messages to the durable contract repository", async () => {
    listDelegationContracts.mockClear();
    const payload: MessagePayload = {
      runtime: { agentId: ENTITY_ID } as IAgentRuntime,
      message: message(),
      source: "test",
    };
    await handleDelegationInboundMessage(payload);
    expect(listDelegationContracts).toHaveBeenCalledWith(ENTITY_ID, {
      statuses: ["active"],
      activeAtIso: "2026-07-09T18:00:00.000Z",
    });
  });

  it("fails fast when connector metadata omits message time", () => {
    expect(() =>
      delegationInboundTurnFromMessage(
        message({
          createdAt: undefined,
          metadata: { type: "message", source: "signal" },
        }),
      ),
    ).toThrow("connector message has no timestamp");
  });
});
