import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  installSkillCallbackBridge,
  parseUseSkillDirective,
} from "../services/skill-callback-bridge.js";

describe("parseUseSkillDirective", () => {
  it("parses a standalone USE_SKILL directive with JSON args", () => {
    expect(
      parseUseSkillDirective(
        'USE_SKILL parent-agent {"request":"List my calendar actions"}',
      ),
    ).toEqual({
      slug: "parent-agent",
      args: { request: "List my calendar actions" },
    });
  });

  it("rejects uppercase slugs", () => {
    expect(parseUseSkillDirective("USE_SKILL Parent-Agent {}")).toBeNull();
  });

  it("routes parent-agent virtual broker without the disk USE_SKILL action", async () => {
    let listener:
      | ((sessionId: string, event: string, data: unknown) => void)
      | undefined;
    const sendToSession = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      getSetting: () => undefined,
      actions: [],
      createMemory: vi.fn().mockResolvedValue(undefined),
      messageService: {
        handleMessage: vi.fn(async () => ({
          responseContent: { text: "Parent handled it." },
        })),
      },
    } as unknown as IAgentRuntime;
    const ptyService = {
      onSessionEvent: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
      getSession: vi.fn(() => ({
        id: "session-1",
        status: "running",
        workdir: "/repo",
      })),
      sendToSession,
    };

    installSkillCallbackBridge({
      runtime,
      ptyService: ptyService as never,
      sessionAllowList: {
        register: () => undefined,
        clear: () => undefined,
        get: () => ["parent-agent"],
      },
    });

    listener?.("session-1", "message", {
      text: 'USE_SKILL parent-agent {"request":"ping the parent"}',
    });

    await vi.waitFor(() => {
      expect(sendToSession).toHaveBeenCalledTimes(1);
    });
    expect(sendToSession.mock.calls[0]?.[1]).toContain("Parent handled it.");
  });
});
