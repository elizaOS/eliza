/**
 * Character-voice contract test for assessment 03-natural-responses.
 *
 * SCREEN_TIME used to stream a hand-formatted string directly to the user
 * via `callback?.({ text })`, with no LLM rewrite pass. It also set
 * `suppressPostActionContinuation: true`, so the runtime composer never
 * got a chance to chain REPLY and re-voice the output.
 *
 * The handler now routes every reply through `renderLifeOpsActionReply`
 * (`apps/app-lifeops/src/actions/lifeops-grounded-reply.ts`), which calls
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
      async getScreenTimeSummary() {
        return {
          totalSeconds: 3600,
          items: [
            { source: "app", displayName: "Twitter", totalSeconds: 1800 },
            { source: "app", displayName: "Slack", totalSeconds: 1800 },
          ],
        };
      }
    },
  };
});

import { screenTimeAction } from "./screen-time.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000a311" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000b311" as UUID;

function makeMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-00000000c311" as UUID,
    agentId: AGENT_ID,
    entityId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

describe("SCREEN_TIME emits character-voiced text", () => {
  it("rewrites the raw 'Top apps (total ...)' string through character voice", async () => {
    const useModel = vi.fn(
      async (
        _modelType: ModelTypeName,
        _params: { prompt: string },
      ): Promise<string> => {
        // A real character-voice rewrite would call useModel with a
        // prompt containing bio + system + recent conversation +
        // action history + the canonical fallback. Return a plausible
        // re-voiced reply so we can assert character voice was applied.
        return "okay love, here's where the time went today: Twitter and Slack ate about 30m each.";
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

    const result = await screenTimeAction.handler!(
      runtime,
      makeMessage("how much screen time did I burn today?"),
      undefined,
      { parameters: { subaction: "summary" } },
      callback,
    );

    // 1) The model SHOULD have been called to re-voice the raw output.
    expect(useModel).toHaveBeenCalledTimes(1);

    // 2) The prompt SHOULD contain the character voice signal.
    const prompt = useModel.mock.calls[0]?.[1]?.prompt as string | undefined;
    expect(prompt ?? "").toMatch(/Samantha/);
    expect(prompt ?? "").toMatch(/Bio|System|Character voice/i);

    // 3) The streamed text SHOULD be the rewritten reply, not the raw
    //    "Top apps (total 1h 0m):\n- Twitter — 30m\n- Slack — 30m" string.
    const streamed = callback.mock.calls[0]?.[0] as
      | { text?: string }
      | undefined;
    expect(streamed?.text ?? "").not.toMatch(/^Top apps \(total/);
    expect(streamed?.text ?? "").toMatch(/love/);

    // 4) The ActionResult.text should also be the re-voiced reply so
    //    downstream context (ACTION_STATE provider) carries the voiced
    //    version, not raw.
    expect(typeof result === "object" && result && "text" in result
      ? (result as { text?: string }).text
      : "").toMatch(/love/);
  });
});
