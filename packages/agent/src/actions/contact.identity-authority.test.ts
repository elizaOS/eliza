/**
 * CONTACT rejects agent-authored identity links and merges before the real
 * relationships service can propose or commit graph mutations.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { contactAction } from "./contact.ts";

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
const SENDER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as UUID;
const ROOM_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID;

function makeRuntime() {
  const graph = {
    proposeMerge: vi.fn(),
    acceptMerge: vi.fn(),
    rejectMerge: vi.fn(),
    getCandidateMerges: vi.fn(),
  };
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    getService: vi.fn((type: string) =>
      type === "relationships" ? graph : null,
    ),
    reportError: vi.fn(),
    registerSearchCategory: vi.fn(),
  } as unknown as IAgentRuntime;
  return { runtime, graph };
}

function makeMessage(text: string): Memory {
  return {
    id: "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID,
    entityId: SENDER_ID,
    roomId: ROOM_ID,
    content: { text, source: "client_chat" },
  } as Memory;
}

async function invoke(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: Record<string, unknown>,
) {
  const result = await contactAction.handler(runtime, message, undefined, {
    parameters,
  } as never);
  if (!result) throw new Error("CONTACT returned no result");
  return result;
}

describe("CONTACT identity-authority hard cut", () => {
  it.each([
    {
      label: "link with model-authored confirmation",
      message: "yes, those accounts are the same person",
      parameters: {
        action: "link",
        entityA: "11111111-1111-1111-1111-111111111111",
        entityB: "22222222-2222-2222-2222-222222222222",
        confirmation: true,
      },
    },
    {
      label: "merge acceptance",
      message: "accept that identity merge",
      parameters: {
        op: "merge",
        action: "accept",
        candidateId: "33333333-3333-3333-3333-333333333333",
      },
    },
  ])(
    "rejects $label without graph mutation",
    async ({ message, parameters }) => {
      const { runtime, graph } = makeRuntime();
      const result = await invoke(runtime, makeMessage(message), parameters);

      expect(result.success).toBe(false);
      expect(result.values).toMatchObject({ error: "INVALID" });
      expect(graph.proposeMerge).not.toHaveBeenCalled();
      expect(graph.acceptMerge).not.toHaveBeenCalled();
      expect(graph.rejectMerge).not.toHaveBeenCalled();
    },
  );

  it("does not advertise identity mutation parameters", () => {
    const actionParameter = contactAction.parameters?.find(
      (parameter) => parameter.name === "action",
    );
    expect(actionParameter?.schema).toMatchObject({
      enum: [
        "create",
        "read",
        "search",
        "update",
        "delete",
        "activity",
        "followup",
      ],
    });
    expect(
      contactAction.parameters?.map((parameter) => parameter.name),
    ).not.toEqual(
      expect.arrayContaining([
        "entityA",
        "entityB",
        "linkTo",
        "confirmation",
        "candidateId",
        "mergeWith",
      ]),
    );
  });
});
