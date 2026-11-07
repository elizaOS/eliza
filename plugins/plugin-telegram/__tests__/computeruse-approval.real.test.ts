/**
 * A computer-use approval runs an action on the owner's machine. Taps on the
 * Telegram inline buttons go through the real callback handler: the owner
 * resolves the approval, the requester may deny their own request, and every
 * other tap is refused, including the requester's approve.
 */
import {
  encodeReplyCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "../src/messageManager";

const OWNER_ENTITY_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const AGENT_ID = "22222222-2222-4222-8222-222222222222" as UUID;
const OWNER_TELEGRAM_ID = "1001";
const MEMBER_TELEGRAM_ID = "2002";

function setup() {
  const resolveApproval = vi.fn(() => ({ id: "approval_1" }));
  const createMemory = vi.fn(async (_memory: Memory, _table: string) => true);
  const answers: string[] = [];
  const runtime = {
    agentId: AGENT_ID,
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ENTITY_ID : null,
    getEntityById: async (id: UUID) =>
      id === OWNER_ENTITY_ID
        ? {
            id: OWNER_ENTITY_ID,
            names: ["Owner"],
            agentId: AGENT_ID,
            metadata: { telegram: { userId: OWNER_TELEGRAM_ID } },
          }
        : null,
    getService: (name: string) =>
      name === "computeruse" ? { resolveApproval } : null,
    createMemory,
    reportError: vi.fn(),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as IAgentRuntime;
  const editMessageText = vi.fn(async () => true);
  const manager = new MessageManager(
    { telegram: { editMessageText } } as never,
    runtime,
  );
  const tap = (fromId: string, approved: boolean, topic = false) => {
    const chat = topic
      ? { id: -100500, type: "supergroup", is_forum: true }
      : { id: 5005, type: "private" };
    return manager.handleCallbackQuery({
      from: { id: Number(fromId), first_name: "Tapper" },
      chat,
      callbackQuery: {
        id: `q-${fromId}-${approved}`,
        // The relay bound the buttons to the member who asked.
        data: encodeReplyCallback(
          `cua:approval_1:${approved ? "approve" : "deny"}:u${MEMBER_TELEGRAM_ID}`,
        ),
        message: {
          message_id: 7,
          chat,
          ...(topic ? { is_topic_message: true, message_thread_id: 42 } : {}),
        },
      },
      answerCbQuery: async (text?: string) => {
        answers.push(text ?? "");
        return true;
      },
    } as never);
  };
  return { resolveApproval, createMemory, answers, tap };
}

describe("Telegram computer-use approval buttons", () => {
  it("does not let the requester approve their own request on the owner's machine", async () => {
    const { resolveApproval, createMemory, answers, tap } = setup();
    await tap(MEMBER_TELEGRAM_ID, true);
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
    expect(answers).toEqual(["Only the owner can approve this request."]);
  });

  it("lets the requester deny their own request and records the decision", async () => {
    const { resolveApproval, createMemory, tap } = setup();
    await tap(MEMBER_TELEGRAM_ID, false);
    expect(resolveApproval).toHaveBeenCalledWith(
      "approval_1",
      false,
      expect.any(String),
    );
    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(createMemory.mock.calls[0]?.[1]).toBe("messages");
  });

  it("lets the owner approve a request a member made, also in a forum topic", async () => {
    for (const topic of [false, true]) {
      const { resolveApproval, createMemory, tap } = setup();
      await tap(OWNER_TELEGRAM_ID, true, topic);
      expect(resolveApproval, `topic=${topic}`).toHaveBeenCalledWith(
        "approval_1",
        true,
        expect.any(String),
      );
      expect(createMemory, `topic=${topic}`).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a third person", async () => {
    const { resolveApproval, createMemory, tap } = setup();
    await tap("3003", true);
    await tap("3003", false);
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
  });
});
