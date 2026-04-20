import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  getSelfControlAccess: vi.fn(),
}));

const engineMocks = vi.hoisted(() => ({
  getSelfControlPermissionState: vi.fn(),
  getSelfControlStatus: vi.fn(),
  requestSelfControlPermission: vi.fn(),
  startSelfControlBlock: vi.fn(),
  stopSelfControlBlock: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  syncWebsiteBlockerExpiryTask: vi.fn(),
}));

vi.mock("../website-blocker/access.ts", () => ({
  SELFCONTROL_ACCESS_ERROR: "SelfControl access denied.",
  getSelfControlAccess: accessMocks.getSelfControlAccess,
}));

vi.mock("../website-blocker/service.ts", () => ({
  syncWebsiteBlockerExpiryTask: serviceMocks.syncWebsiteBlockerExpiryTask,
}));

vi.mock("../website-blocker/engine.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../website-blocker/engine.ts")
  >("../website-blocker/engine.ts");
  return {
    ...actual,
    getSelfControlPermissionState: engineMocks.getSelfControlPermissionState,
    getSelfControlStatus: engineMocks.getSelfControlStatus,
    requestSelfControlPermission: engineMocks.requestSelfControlPermission,
    startSelfControlBlock: engineMocks.startSelfControlBlock,
    stopSelfControlBlock: engineMocks.stopSelfControlBlock,
  };
});

import { parseSelfControlBlockRequest } from "../website-blocker/engine.js";
import {
  blockWebsitesAction,
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

describe("website blocker actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    accessMocks.getSelfControlAccess.mockResolvedValue({ allowed: true });
    engineMocks.getSelfControlPermissionState.mockResolvedValue({
      status: "granted",
      canRequest: false,
      id: "website-blocking",
    });
    engineMocks.getSelfControlStatus.mockResolvedValue({
      active: false,
      available: true,
      canUnblockEarly: true,
      elevationPromptMethod: null,
      endsAt: null,
      engine: "hosts-file",
      hostsFilePath: "/etc/hosts",
      managedBy: null,
      metadata: null,
      platform: process.platform,
      reason: undefined,
      requiresElevation: false,
      scheduledByAgentId: null,
      startedAt: null,
      supportsElevationPrompt: false,
      websites: [],
    });
    engineMocks.requestSelfControlPermission.mockResolvedValue({
      status: "granted",
      canRequest: false,
      id: "website-blocking",
    });
    engineMocks.startSelfControlBlock.mockResolvedValue({
      success: true,
      endsAt: null,
    });
    engineMocks.stopSelfControlBlock.mockResolvedValue({
      success: true,
      removed: true,
      status: {
        active: false,
        available: true,
        canUnblockEarly: true,
        elevationPromptMethod: null,
        endsAt: null,
        engine: "hosts-file",
        hostsFilePath: "/etc/hosts",
        managedBy: null,
        metadata: null,
        platform: process.platform,
        reason: undefined,
        requiresElevation: false,
        scheduledByAgentId: null,
        startedAt: null,
        supportsElevationPrompt: false,
        websites: [],
      },
    });
    serviceMocks.syncWebsiteBlockerExpiryTask.mockResolvedValue(
      "00000000-0000-0000-0000-00000000task",
    );
  });

  it("treats omitted duration as a manual block", () => {
    expect(
      parseSelfControlBlockRequest({
        parameters: {
          websites: ["x.com"],
        },
      }),
    ).toEqual({
      request: {
        websites: ["x.com"],
        durationMinutes: null,
      },
    });
  });

  it("rejects invalid explicit duration values instead of silently defaulting", () => {
    expect(
      parseSelfControlBlockRequest({
        parameters: {
          websites: ["x.com"],
          durationMinutes: "soon",
        },
      }),
    ).toEqual({
      request: null,
      error:
        "Duration must be a positive number of minutes, or null for a manual block.",
    });
  });

  it("uses the full provider-backed recent conversation when resolving a follow-up block", async () => {
    const useModel = vi.fn(async (_model, args: { prompt: string }) => {
      expect(args.prompt).toContain(
        "The websites distracting me are x.com and twitter.com. Do not block them yet.",
      );
      expect(args.prompt).toContain(
        "Let's talk about lunch instead for a second.",
      );
      return JSON.stringify({
        shouldAct: true,
        confirmed: true,
        websites: ["x.com", "twitter.com"],
      });
    });
    const runtime = createRuntime({ useModel });
    const state = createRecentConversationState([
      "The websites distracting me are x.com and twitter.com. Do not block them yet.",
      "I noted those websites and will wait for your confirmation before blocking them.",
      "Let's talk about lunch instead for a second.",
      "Sure. What do you want for lunch?",
    ]);

    const result = (await blockWebsitesAction.handler(
      runtime,
      createMessage("Actually block them now."),
      state,
      undefined,
    )) as ActionResult;

    expect(useModel).toHaveBeenCalledTimes(1);
    expect(engineMocks.startSelfControlBlock).toHaveBeenCalledWith({
      websites: ["x.com", "twitter.com"],
      durationMinutes: null,
      scheduledByAgentId: AGENT_ID,
    });
    expect(serviceMocks.syncWebsiteBlockerExpiryTask).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.text).toContain(
      "Started a website block for x.com, twitter.com until you unblock it.",
    );
  });

  it("schedules automatic unblock tasks for timed blocks", async () => {
    engineMocks.startSelfControlBlock.mockResolvedValue({
      success: true,
      endsAt: "2026-04-19T20:00:00.000Z",
    });
    const runtime = createRuntime();

    const result = (await blockWebsitesAction.handler(
      runtime,
      createMessage("Block x.com for 30 minutes."),
      undefined,
      {
        parameters: {
          websites: ["x.com"],
          durationMinutes: 30,
          confirmed: true,
        },
      } as HandlerOptions,
    )) as ActionResult;

    expect(engineMocks.startSelfControlBlock).toHaveBeenCalledWith({
      websites: ["x.com"],
      durationMinutes: 30,
      scheduledByAgentId: AGENT_ID,
    });
    expect(serviceMocks.syncWebsiteBlockerExpiryTask).toHaveBeenCalledWith(
      runtime,
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain("until 2026-04-19T20:00:00.000Z");
  });

  it("surfaces hosts-file validation failures instead of claiming the website was blocked", async () => {
    engineMocks.startSelfControlBlock.mockResolvedValue({
      success: false,
      error:
        "Eliza updated the system hosts file, but these websites still resolved outside loopback on this machine: x.com, api.x.com. The website block was rolled back because it would not be effective.",
    });
    const runtime = createRuntime();

    const result = (await blockWebsitesAction.handler(
      runtime,
      createMessage("Block x.com now."),
      undefined,
      {
        parameters: {
          websites: ["x.com"],
          confirmed: true,
        },
      } as HandlerOptions,
    )) as ActionResult;

    expect(serviceMocks.syncWebsiteBlockerExpiryTask).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.text).toContain(
      "rolled back because it would not be effective",
    );
  });

  it("allows early unblocking for timed blocks and says so explicitly", async () => {
    engineMocks.getSelfControlStatus.mockResolvedValue({
      active: true,
      available: true,
      canUnblockEarly: true,
      elevationPromptMethod: null,
      endsAt: "2026-04-19T20:00:00.000Z",
      engine: "hosts-file",
      hostsFilePath: "/etc/hosts",
      managedBy: "eliza-selfcontrol",
      metadata: null,
      platform: process.platform,
      reason: undefined,
      requiresElevation: false,
      scheduledByAgentId: AGENT_ID,
      startedAt: "2026-04-19T19:30:00.000Z",
      supportsElevationPrompt: false,
      websites: ["x.com"],
    });
    const runtime = createRuntime();

    const result = (await unblockWebsitesAction.handler(
      runtime,
      createMessage("Unblock x.com now."),
      undefined,
      undefined,
    )) as ActionResult;

    expect(engineMocks.stopSelfControlBlock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.text).toContain(
      "Removed the website block for x.com before its scheduled end time.",
    );
  });

  it("allows manual blocks to be removed without a timed-block warning", async () => {
    engineMocks.getSelfControlStatus.mockResolvedValue({
      active: true,
      available: true,
      canUnblockEarly: true,
      elevationPromptMethod: null,
      endsAt: null,
      engine: "hosts-file",
      hostsFilePath: "/etc/hosts",
      managedBy: "eliza-selfcontrol",
      metadata: null,
      platform: process.platform,
      reason: undefined,
      requiresElevation: false,
      scheduledByAgentId: AGENT_ID,
      startedAt: "2026-04-19T19:30:00.000Z",
      supportsElevationPrompt: false,
      websites: ["x.com"],
    });
    const runtime = createRuntime();

    const result = (await unblockWebsitesAction.handler(
      runtime,
      createMessage("Unblock x.com now."),
      undefined,
      undefined,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(result.text).toBe("Removed the website block for x.com.");
  });

  it("reports a no-op unblock cleanly when no website block is active", async () => {
    const runtime = createRuntime();

    const result = (await unblockWebsitesAction.handler(
      runtime,
      createMessage("Unblock x.com now."),
      undefined,
      undefined,
    )) as ActionResult;

    expect(engineMocks.stopSelfControlBlock).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.text).toBe("No website block is active right now.");
  });
});
