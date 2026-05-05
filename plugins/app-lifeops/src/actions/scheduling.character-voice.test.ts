/**
 * Character-voice contract test for assessment 03-natural-responses.
 *
 * The PROPOSE_MEETING_TIMES / CHECK_AVAILABILITY / UPDATE_MEETING_PREFERENCES
 * / SCHEDULING (OWNER_CALENDAR family) actions used to stream 28 raw
 * template strings via `callback?.({ text })` (e.g.,
 * "Updated meeting preferences (...)", "You're free from ... to ...",
 * "Started Negotiation ... and notified the counterparty.") with no LLM
 * rewrite pass. Each emit-site now routes through `renderLifeOpsActionReply`
 * (`apps/app-lifeops/src/actions/lifeops-grounded-reply.ts`), which calls
 * `useModel(TEXT_SMALL)` with bio + system + style + recent conversation
 * + action history + the canonical fallback. This test asserts that the
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

vi.mock("../lifeops/owner-profile.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lifeops/owner-profile.js")>();
  return {
    ...actual,
    readLifeOpsMeetingPreferences: async () => ({
      timeZone: "America/Los_Angeles",
      preferredStartLocal: "09:00",
      preferredEndLocal: "17:00",
      defaultDurationMinutes: 30,
      travelBufferMinutes: 15,
      blackoutWindows: [],
      updatedAt: "2026-04-01T00:00:00.000Z",
    }),
    updateLifeOpsMeetingPreferences: async (
      _runtime: unknown,
      _patch: unknown,
    ) => ({
      timeZone: "America/Los_Angeles",
      preferredStartLocal: "10:00",
      preferredEndLocal: "17:00",
      defaultDurationMinutes: 30,
      travelBufferMinutes: 15,
      blackoutWindows: [],
      updatedAt: "2026-05-03T00:00:00.000Z",
    }),
  };
});

import { updateMeetingPreferencesAction } from "./scheduling.js";

const AGENT_ID = "00000000-0000-0000-0000-000000010111" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000010211" as UUID;

function makeMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000010311" as UUID,
    agentId: AGENT_ID,
    entityId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

describe("OWNER_CALENDAR scheduling actions emit character-voiced text", () => {
  it("rewrites the raw 'Updated meeting preferences (...)' string through character voice", async () => {
    const useModel = vi.fn(
      async (
        _modelType: ModelTypeName,
        _params: { prompt: string },
      ): Promise<string> => {
        return "okay love, mornings are protected now — meetings start at ten and the rest of your day stays the same.";
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

    const result = await updateMeetingPreferencesAction.handler!(
      runtime,
      makeMessage("don't schedule meetings before 10am"),
      undefined,
      { parameters: { preferredStartLocal: "10:00" } },
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
    expect(streamed?.text ?? "").not.toMatch(/^Updated meeting preferences/);
    expect(streamed?.text ?? "").toMatch(/love/);

    // The ActionResult.text should also be the re-voiced reply so downstream
    // context (ACTION_STATE provider) carries the voiced version, not raw.
    expect(typeof result === "object" && result && "text" in result
      ? (result as { text?: string }).text
      : "").toMatch(/love/);
  });
});
