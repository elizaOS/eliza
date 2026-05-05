import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { extractCalendarPlanWithLlm } from "../src/actions/calendar.js";
import { extractGmailPlanWithLlm } from "../src/actions/gmail.js";

function message(text: string): Memory {
  return {
    id: "m1",
    roomId: "r1",
    entityId: "u1",
    content: { text, source: "test" },
  } as Memory;
}

function runtimeWithModelResponses(...responses: string[]): IAgentRuntime & {
  useModel: ReturnType<typeof vi.fn>;
} {
  const useModel = vi.fn();
  for (const response of responses) {
    useModel.mockResolvedValueOnce(response);
  }
  useModel.mockRejectedValue(new Error("unexpected LifeOps model call"));

  return {
    useModel,
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
    getMemories: vi.fn().mockResolvedValue([]),
  } as unknown as IAgentRuntime & { useModel: ReturnType<typeof vi.fn> };
}

describe("LifeOps Google router compression", () => {
  it("keeps a common calendar feed plan to one TOON extraction call", async () => {
    const runtime = runtimeWithModelResponses(
      ["subaction: feed", "shouldAct: true", "response: null", "queries:"].join(
        "\n",
      ),
    );

    const plan = await extractCalendarPlanWithLlm(
      runtime,
      message("what's on my calendar tomorrow"),
      undefined,
      "what's on my calendar tomorrow",
      "America/Los_Angeles",
    );

    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(plan.subaction).toBe("feed");
    expect(plan.shouldAct).toBe(true);
  });

  it("keeps a calendar search plan with extracted queries to one call", async () => {
    const runtime = runtimeWithModelResponses(
      [
        "subaction: search_events",
        "shouldAct: true",
        "response: null",
        "queries: flight to denver || denver",
      ].join("\n"),
    );

    const plan = await extractCalendarPlanWithLlm(
      runtime,
      message("find my flight to Denver"),
      undefined,
      "find my flight to Denver",
      "America/Los_Angeles",
    );

    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(plan.subaction).toBe("search_events");
    expect(plan.queries).toEqual(["flight to denver", "denver"]);
  });

  it("keeps a Gmail triage plan to one planner call", async () => {
    const runtime = runtimeWithModelResponses(
      ["subaction: triage", "shouldAct: true", "response: null"].join("\n"),
    );

    const plan = await extractGmailPlanWithLlm(
      runtime,
      message("triage my Gmail"),
      undefined,
      "triage my Gmail",
    );

    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(plan.subaction).toBe("triage");
    expect(plan.queries).toEqual([]);
  });

  it("defaults a broad Gmail needs-response plan without a payload pass", async () => {
    const runtime = runtimeWithModelResponses(
      ["subaction: needs_response", "shouldAct: true", "response: null"].join(
        "\n",
      ),
    );

    const plan = await extractGmailPlanWithLlm(
      runtime,
      message("which emails need a reply"),
      undefined,
      "which emails need a reply",
    );

    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(plan.subaction).toBe("needs_response");
    expect(plan.replyNeededOnly).toBe(true);
  });

  it("uses planner-provided Gmail search queries without a second extraction", async () => {
    const runtime = runtimeWithModelResponses(
      [
        "subaction: search",
        "shouldAct: true",
        "response: null",
        "queries: from:sarah",
      ].join("\n"),
    );

    const plan = await extractGmailPlanWithLlm(
      runtime,
      message("search Gmail from Sarah"),
      undefined,
      "search Gmail from Sarah",
    );

    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(plan.subaction).toBe("search");
    expect(plan.queries).toEqual(["from:sarah"]);
  });

  it("keeps the Gmail payload fallback when a filtered search lacks queries", async () => {
    const runtime = runtimeWithModelResponses(
      ["subaction: search", "shouldAct: true", "response: null"].join("\n"),
      "queries: from:sarah",
    );

    const plan = await extractGmailPlanWithLlm(
      runtime,
      message("search Gmail from Sarah"),
      undefined,
      "search Gmail from Sarah",
    );

    expect(runtime.useModel).toHaveBeenCalledTimes(2);
    expect(plan.subaction).toBe("search");
    expect(plan.queries).toEqual(["from:sarah"]);
  });
});
