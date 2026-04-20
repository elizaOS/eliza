import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  getSelfControlAccess: vi.fn(),
}));

vi.mock("../website-blocker/access.ts", () => ({
  SELFCONTROL_ACCESS_ERROR: "SelfControl access denied.",
  getSelfControlAccess: accessMocks.getSelfControlAccess,
}));

import { ownerWebsiteBlockAction } from "./owner-website-block.js";
import {
  blockWebsitesAction,
  getWebsiteBlockStatusAction,
  unblockWebsitesAction,
} from "./website-blocker.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000321" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000654" as UUID;

function createRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    useModel: vi.fn(),
    ...overrides,
  } as unknown as IAgentRuntime;
}

function createMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000999" as UUID,
    entityId: "00000000-0000-0000-0000-000000000998" as UUID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text },
  } as Memory;
}

function createRecentConversationState(lines: string[]): State {
  const transcript = lines
    .map((line, index) => `${index % 2 === 0 ? "user" : "assistant"}: ${line}`)
    .join("\n");

  return {
    values: {
      recentMessages: transcript,
    },
    data: {
      providers: {
        RECENT_MESSAGES: {
          data: {
            recentMessages: lines.map((line, index) => ({
              id: `00000000-0000-0000-0000-0000000000${index}` as UUID,
              entityId:
                index % 2 === 0
                  ? ("00000000-0000-0000-0000-000000000111" as UUID)
                  : AGENT_ID,
              agentId: AGENT_ID,
              roomId: ROOM_ID,
              content: { text: line },
            })),
          },
          values: {
            recentMessages: transcript,
          },
        },
      },
    },
    text: transcript,
  } as State;
}

async function invokeOwnerWebsiteBlock(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: HandlerOptions,
): Promise<ActionResult> {
  const handler = ownerWebsiteBlockAction.handler;
  if (typeof handler !== "function") {
    throw new Error("OWNER_WEBSITE_BLOCK handler is unavailable.");
  }

  return (await handler(runtime, message, state, options)) as ActionResult;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OWNER_WEBSITE_BLOCK routing", () => {
  beforeEach(() => {
    accessMocks.getSelfControlAccess.mockResolvedValue({ allowed: true });
  });

  it("routes direct block requests deterministically without needing the model", async () => {
    const runtime = createRuntime({
      useModel: vi.fn().mockResolvedValue(
        JSON.stringify({
          subaction: "block",
          shouldAct: true,
          response: null,
        }),
      ),
    });
    const blockSpy = vi
      .spyOn(blockWebsitesAction, "handler")
      .mockResolvedValue({
        success: true,
        text: "Started a website block for x.com until you unblock it.",
      } as ActionResult);

    const result = await invokeOwnerWebsiteBlock(
      runtime,
      createMessage("please block x.com for me"),
      undefined,
      { parameters: {} } as HandlerOptions,
    );

    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(blockSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      text: "Started a website block for x.com until you unblock it.",
    });
  });

  it("uses recent conversation to preserve unblock intent when the follow-up message is only a hostname", async () => {
    const useModel = vi.fn(async (_model, args: { prompt: string }) => {
      expect(args.prompt).toContain("can you unblock x?");
      expect(args.prompt).toContain(
        'could you tell me what "x" is? i need a bit more detail to help unblock it.',
      );
      expect(args.prompt).toContain("x.com");
      return JSON.stringify({
        subaction: "unblock",
        shouldAct: true,
        response: null,
      });
    });
    const runtime = createRuntime({ useModel });
    const state = createRecentConversationState([
      "can you unblock x?",
      'could you tell me what "x" is? i need a bit more detail to help unblock it.',
    ]);
    const unblockSpy = vi
      .spyOn(unblockWebsitesAction, "handler")
      .mockResolvedValue({
        success: true,
        text: "Removed the website block for x.com before its scheduled end time.",
      } as ActionResult);

    const result = await invokeOwnerWebsiteBlock(
      runtime,
      createMessage("x.com"),
      state,
      { parameters: {} } as HandlerOptions,
    );

    expect(useModel).not.toHaveBeenCalled();
    expect(unblockSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      text: "Removed the website block for x.com before its scheduled end time.",
    });
  });

  it("falls back to the model for vague requests", async () => {
    const runtime = createRuntime({
      useModel: vi.fn().mockResolvedValue(
        JSON.stringify({
          subaction: "status",
          shouldAct: true,
          response: null,
        }),
      ),
    });
    const statusSpy = vi
      .spyOn(getWebsiteBlockStatusAction, "handler")
      .mockResolvedValue({
        success: true,
        text: "No website block is active right now.",
      } as ActionResult);

    const result = await invokeOwnerWebsiteBlock(
      runtime,
      createMessage("handle the website thing"),
      undefined,
      { parameters: {} } as HandlerOptions,
    );

    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      text: "No website block is active right now.",
    });
  });
});
