import type { Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { extractGmailPlanWithLlm } from "../src/actions/gmail.js";

function message(text: string): Memory {
  return {
    id: "m1",
    roomId: "r1",
    entityId: "u1",
    content: { text, source: "test" },
  } as Memory;
}

describe("extractGmailPlanWithLlm", () => {
  it("stops after the intent pass for reply-only clarifications", async () => {
    const useModel = vi.fn().mockResolvedValue(
      JSON.stringify({
        subaction: null,
        shouldAct: false,
        response: "What do you want to do in Gmail?",
      }),
    );

    const plan = await extractGmailPlanWithLlm(
      {
        useModel,
        logger: { warn: vi.fn() },
        getMemories: vi.fn().mockResolvedValue([]),
      } as never,
      message("can you help me with my email?"),
      undefined,
      "can you help me with my email?",
    );

    expect(useModel).toHaveBeenCalledTimes(1);
    expect(plan).toEqual({
      subaction: null,
      queries: [],
      response: "What do you want to do in Gmail?",
      shouldAct: false,
    });
  });

  it("skips payload extraction for triage", async () => {
    const useModel = vi.fn().mockResolvedValue(
      JSON.stringify({
        subaction: "triage",
        shouldAct: true,
        response: null,
      }),
    );

    const plan = await extractGmailPlanWithLlm(
      {
        useModel,
        logger: { warn: vi.fn() },
        getMemories: vi.fn().mockResolvedValue([]),
      } as never,
      message("check my inbox"),
      undefined,
      "check my inbox",
    );

    expect(useModel).toHaveBeenCalledTimes(1);
    expect(plan).toEqual({
      subaction: "triage",
      queries: [],
      response: undefined,
      shouldAct: true,
      replyNeededOnly: undefined,
    });
  });

  it("runs a second pass to extract search queries", async () => {
    const useModel = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          subaction: "search",
          shouldAct: true,
          response: null,
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          queries: ["from:suran newer_than:1d"],
        }),
      );

    const plan = await extractGmailPlanWithLlm(
      {
        useModel,
        logger: { warn: vi.fn() },
        getMemories: vi.fn().mockResolvedValue([]),
      } as never,
      message("did Suran email me today"),
      undefined,
      "did Suran email me today",
    );

    expect(useModel).toHaveBeenCalledTimes(2);
    expect(plan).toMatchObject({
      subaction: "search",
      shouldAct: true,
      queries: ["from:suran newer_than:1d"],
    });
  });

  it("forces replyNeededOnly for needs_response even when the payload pass omits it", async () => {
    const useModel = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          subaction: "needs_response",
          shouldAct: true,
          response: null,
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          queries: ["venue"],
        }),
      );

    const plan = await extractGmailPlanWithLlm(
      {
        useModel,
        logger: { warn: vi.fn() },
        getMemories: vi.fn().mockResolvedValue([]),
      } as never,
      message("which emails need a reply about venue"),
      undefined,
      "which emails need a reply about venue",
    );

    expect(useModel).toHaveBeenCalledTimes(2);
    expect(plan).toMatchObject({
      subaction: "needs_response",
      shouldAct: true,
      queries: ["venue"],
      replyNeededOnly: true,
    });
  });

  it("extracts outbound email fields in the payload pass", async () => {
    const useModel = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          subaction: "send_message",
          shouldAct: true,
          response: null,
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          to: ["zo@iqlabs.dev"],
          subject: "hello anon",
          bodyText: "how are you doing today?",
        }),
      );

    const plan = await extractGmailPlanWithLlm(
      {
        useModel,
        logger: { warn: vi.fn() },
        getMemories: vi.fn().mockResolvedValue([]),
      } as never,
      message(
        "send an email to zo@iqlabs.dev, subject hello anon, body how are you doing today?",
      ),
      undefined,
      "send an email to zo@iqlabs.dev, subject hello anon, body how are you doing today?",
    );

    expect(useModel).toHaveBeenCalledTimes(2);
    expect(plan).toMatchObject({
      subaction: "send_message",
      shouldAct: true,
      to: ["zo@iqlabs.dev"],
      subject: "hello anon",
      bodyText: "how are you doing today?",
    });
  });
});
