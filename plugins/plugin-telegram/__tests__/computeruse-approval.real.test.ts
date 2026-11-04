/**
 * A computer-use approval runs an action on the owner's machine. The Telegram
 * inline buttons resolve it for the owner, let the requester deny their own
 * request, and refuse every other approval, including the requester's.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "../src/messageManager";

const OWNER_ENTITY_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const OWNER_TELEGRAM_ID = "1001";
const MEMBER_TELEGRAM_ID = "2002";

function setup() {
  const resolveApproval = vi.fn(() => ({ id: "approval_1" }));
  const answers: string[] = [];
  const runtime = {
    agentId: "22222222-2222-4222-8222-222222222222",
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ENTITY_ID : null,
    getEntityById: async (id: UUID) =>
      id === OWNER_ENTITY_ID
        ? {
            id: OWNER_ENTITY_ID,
            names: ["Owner"],
            agentId: "22222222-2222-4222-8222-222222222222",
            metadata: { telegram: { userId: OWNER_TELEGRAM_ID } },
          }
        : null,
    getService: (name: string) =>
      name === "computeruse" ? { resolveApproval } : null,
    reportError: vi.fn(),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as IAgentRuntime;
  const manager = new MessageManager({} as never, runtime);
  // Recording the decision and editing the prompt are not under test here.
  Object.assign(manager, {
    persistComputerUseApprovalDecisionMemory: async () => {},
    editMessage: async () => {},
  });
  const chat = { id: 5005, type: "private" };
  const tap = (fromId: string, approved: boolean) =>
    (
      manager as unknown as {
        resolveComputerUseApprovalCallback: (
          ...args: unknown[]
        ) => Promise<void>;
      }
    ).resolveComputerUseApprovalCallback(
      {
        from: { id: Number(fromId) },
        chat,
        answerCbQuery: async (text: string) => {
          answers.push(text);
          return true;
        },
        editMessageText: async () => true,
        editMessageReplyMarkup: async () => true,
        reply: async () => ({}),
      },
      chat,
      1,
      undefined,
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "DM",
      {
        approvalId: "approval_1",
        approved,
        // The button was relayed to the member who asked.
        ownerId: MEMBER_TELEGRAM_ID,
      },
    );
  return { resolveApproval, answers, tap };
}

describe("Telegram computer-use approval buttons", () => {
  it("does not let the requester approve their own request on the owner's machine", async () => {
    const { resolveApproval, tap } = setup();
    await tap(MEMBER_TELEGRAM_ID, true);
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("lets the requester deny their own request", async () => {
    const { resolveApproval, tap } = setup();
    await tap(MEMBER_TELEGRAM_ID, false);
    expect(resolveApproval).toHaveBeenCalledWith(
      "approval_1",
      false,
      expect.any(String),
    );
  });

  it("lets the owner approve a request a member made", async () => {
    const { resolveApproval, tap } = setup();
    await tap(OWNER_TELEGRAM_ID, true);
    expect(resolveApproval).toHaveBeenCalledWith(
      "approval_1",
      true,
      expect.any(String),
    );
  });

  it("refuses a third person", async () => {
    const { resolveApproval, tap } = setup();
    await tap("3003", true);
    await tap("3003", false);
    expect(resolveApproval).not.toHaveBeenCalled();
  });
});
