/**
 * Character-voice contract test for assessment 03-natural-responses.
 *
 * HEALTH used to stream raw "Health summary for ..." templates directly to the
 * user via `callback?.({ text })`, with no LLM rewrite pass. The handler now
 * routes every reply through `renderLifeOpsActionReply`
 * (`plugins/app-lifeops/src/actions/lifeops-grounded-reply.ts`), which calls
 * `useModel(TEXT_SMALL)` with bio + system + style + recent conversation
 * + action history + the canonical fallback. These tests assert that the
 * model is called once per turn with the character voice context and that
 * the streamed callback + ActionResult.text are the rewritten reply.
 */

import type {
  IAgentRuntime,
  Memory,
  ModelTypeName,
  UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("./lifeops-google-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("./lifeops-google-helpers.js")
  >();
  return {
    ...actual,
    hasLifeOpsAccess: async () => true,
  };
});

vi.mock("../lifeops/service.js", () => {
  return {
    LifeOpsService: class {
      async getHealthConnectorStatus() {
        return { available: true, backend: "healthkit" };
      }
      async getHealthSummary() {
        return {
          providers: [{ provider: "healthkit", connected: true }],
          summaries: [],
          samples: [],
        };
      }
      async getHealthDailySummary(date: string) {
        return {
          date,
          steps: 8420,
          activeMinutes: 47,
          sleepHours: 7.4,
          source: "healthkit",
          heartRateAvg: 62,
        };
      }
    },
  };
});

import { healthAction } from "./health.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000d111" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d211" as UUID;

function makeMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-00000000d311" as UUID,
    agentId: AGENT_ID,
    entityId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

describe("HEALTH emits character-voiced text", () => {
  it("rewrites the raw 'Health summary for ...' string through character voice", async () => {
    const useModel = vi.fn(
      async (
        _modelType: ModelTypeName,
        _params: { prompt: string },
      ): Promise<string> => {
        return "okay love, you walked 8,420 steps and slept about seven and a half hours last night.";
      },
    );

    const runtime = {
      agentId: AGENT_ID,
      character: {
        name: "Samantha",
        system:
          "You are Samantha, warm and intimate. Always speak in first person, soft and grounded.",
        bio: ["Soft-spoken AI companion", "Calls the user 'love'"],
        style: { all: ["lowercase", "warm"], chat: ["short", "intimate"] },
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      useModel,
    } as unknown as IAgentRuntime;

    const callback = vi.fn(async () => []);

    const result = await healthAction.handler!(
      runtime,
      makeMessage("how many steps did I take today?"),
      undefined,
      { parameters: { subaction: "today" } },
      callback,
    );

    // The model SHOULD have been called once to re-voice the raw output.
    expect(useModel).toHaveBeenCalledTimes(1);

    // The prompt SHOULD contain the character voice signal.
    const prompt = useModel.mock.calls[0]?.[1]?.prompt as string | undefined;
    expect(prompt ?? "").toMatch(/Samantha/);
    expect(prompt ?? "").toMatch(/Bio|System|Character voice/i);

    // The streamed text SHOULD be the rewritten reply, not the raw template.
    const streamed = callback.mock.calls[0]?.[0] as
      | { text?: string }
      | undefined;
    expect(streamed?.text ?? "").not.toMatch(/^Health summary for/);
    expect(streamed?.text ?? "").toMatch(/love/);

    // The ActionResult.text should also be the re-voiced reply so downstream
    // context (ACTION_STATE provider) carries the voiced version, not raw.
    expect(typeof result === "object" && result && "text" in result
      ? (result as { text?: string }).text
      : "").toMatch(/love/);
  });
});
