/**
 * Character-voice contract test for assessment 03-natural-responses.
 *
 * GET_ACTIVITY_REPORT used to stream the raw "Activity report (Xm total):..."
 * template directly to the user via `callback?.({ text })`, with no LLM
 * rewrite pass. The handler now routes every reply through
 * `renderLifeOpsActionReply` (`apps/app-lifeops/src/actions/lifeops-grounded-reply.ts`),
 * which calls `useModel(TEXT_SMALL)` with bio + system + style + recent
 * conversation + action history + the canonical fallback. This test asserts
 * that the model is called once per turn with the character voice context and
 * that the streamed callback + ActionResult.text are the rewritten reply.
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

vi.mock("@elizaos/native-activity-tracker", () => {
  return {
    isSupportedPlatform: () => true,
  };
});

vi.mock("../activity-profile/activity-tracker-reporting.js", () => {
  return {
    getActivityReport: async () => ({
      sinceMs: 0,
      untilMs: 1_000,
      totalMs: 312 * 60_000,
      apps: [
        { appName: "VS Code", bundleId: "com.microsoft.VSCode", totalMs: 184 * 60_000 },
        { appName: "Safari", bundleId: "com.apple.Safari", totalMs: 82 * 60_000 },
      ],
    }),
    getTimeOnApp: async () => ({
      totalMs: 0,
      matchedBy: "none" as const,
    }),
  };
});

import { getActivityReportAction } from "./activity-report.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000e111" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000e211" as UUID;

function makeMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-00000000e311" as UUID,
    agentId: AGENT_ID,
    entityId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

describe("GET_ACTIVITY_REPORT emits character-voiced text", () => {
  it("rewrites the raw 'Activity report (Xm total): ...' string through character voice", async () => {
    const useModel = vi.fn(
      async (
        _modelType: ModelTypeName,
        _params: { prompt: string },
      ): Promise<string> => {
        return "okay love, today was mostly VS Code and a chunk of Safari — about 5 hours of focus.";
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

    const result = await getActivityReportAction.handler!(
      runtime,
      makeMessage("what did I work on today?"),
      undefined,
      { parameters: { windowHours: 24 } },
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
    expect(streamed?.text ?? "").not.toMatch(/^Activity report \(/);
    expect(streamed?.text ?? "").toMatch(/love/);

    // The ActionResult.text should also be the re-voiced reply so downstream
    // context (ACTION_STATE provider) carries the voiced version, not raw.
    expect(typeof result === "object" && result && "text" in result
      ? (result as { text?: string }).text
      : "").toMatch(/love/);
  });
});
