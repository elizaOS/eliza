/**
 * Character-voice contract test for assessment 03-natural-responses.
 *
 * OWNER_RELATIONSHIP used to stream raw "You have N contacts: ..." (and 23
 * other) templates directly to the user via `callback?.({ text })`, with no
 * LLM rewrite pass. The handler now routes every reply through
 * `renderLifeOpsActionReply`
 * (`plugins/app-lifeops/src/actions/lifeops-grounded-reply.ts`), which calls
 * `useModel(TEXT_SMALL)` with bio + system + style + recent conversation
 * + action history + the canonical fallback. This test asserts that the
 * model is called once per turn with the character voice context and that
 * the streamed callback + ActionResult.text are the rewritten reply.
 */

import type { IAgentRuntime, Memory, ModelTypeName, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("./lifeops-google-helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./lifeops-google-helpers.js")>();
  return {
    ...actual,
    hasLifeOpsAccess: async () => true,
  };
});

vi.mock("../lifeops/service.js", () => {
  return {
    LifeOpsService: class {
      async listRelationships() {
        return [
          {
            id: "rel-1",
            name: "Alice",
            primaryChannel: "telegram",
            primaryHandle: "@alice",
            email: null,
            phone: null,
            notes: "",
            tags: [],
            relationshipType: "contact",
            lastContactedAt: "2026-04-30T00:00:00.000Z",
            metadata: {},
          },
          {
            id: "rel-2",
            name: "Bob",
            primaryChannel: "email",
            primaryHandle: "bob@example.com",
            email: "bob@example.com",
            phone: null,
            notes: "",
            tags: [],
            relationshipType: "contact",
            lastContactedAt: null,
            metadata: {},
          },
        ];
      }
    },
  };
});

import { relationshipAction } from "./relationships.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000f111" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000f211" as UUID;

function makeMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-00000000f311" as UUID,
    agentId: AGENT_ID,
    entityId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

describe("OWNER_RELATIONSHIP emits character-voiced text", () => {
  it("rewrites the raw 'You have N contacts: ...' string through character voice", async () => {
    const useModel = vi.fn(
      async (
        _modelType: ModelTypeName,
        _params: { prompt: string },
      ): Promise<string> => {
        return "okay love, you've got two people in your rolodex right now — alice and bob.";
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

    const result = await relationshipAction.handler!(
      runtime,
      makeMessage("show me my contacts"),
      undefined,
      { parameters: { subaction: "list_contacts" } },
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
    expect(streamed?.text ?? "").not.toMatch(/^You have \d+ contact/);
    expect(streamed?.text ?? "").toMatch(/love/);

    // The ActionResult.text should also be the re-voiced reply so downstream
    // context (ACTION_STATE provider) carries the voiced version, not raw.
    expect(
      typeof result === "object" && result && "text" in result
        ? (result as { text?: string }).text
        : "",
    ).toMatch(/love/);
  });
});
