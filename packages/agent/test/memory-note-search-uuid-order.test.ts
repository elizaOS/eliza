/**
 * Hash-memory search slices after ranking. Equal notes saved in the same
 * millisecond must keep the higher UUID when the page holds one hit.
 */
import type http from "node:http";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  HASH_MEMORY_SOURCE,
  handleMemoryRoutes,
} from "../src/api/memory-routes.ts";

const AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const LOWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const UPPER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const SAME = 1_700_000_000_000;

function note(id: UUID): Memory {
  return {
    id,
    agentId: AGENT,
    entityId: AGENT,
    roomId: AGENT,
    createdAt: SAME,
    content: { text: "dentist appointment", source: HASH_MEMORY_SOURCE },
  };
}

describe("memory note search UUID ties", () => {
  it("returns the higher UUID when two equal notes share a millisecond", async () => {
    let body = "";
    const runtime = {
      agentId: AGENT,
      character: { name: "Eliza" },
      ensureConnection: async () => undefined,
      getMemories: async () => [note(LOWER), note(UPPER)],
      countMemories: async () => 2,
      reportError() {},
    } as unknown as AgentRuntime;
    const url = new URL("http://127.0.0.1/api/memory/search?q=dentist&limit=1");

    const handled = await handleMemoryRoutes({
      req: { url: `${url.pathname}${url.search}` } as http.IncomingMessage,
      res: { setHeader() {}, end() {} } as unknown as http.ServerResponse,
      method: "GET",
      pathname: url.pathname,
      url,
      runtime,
      agentName: "Eliza",
      json(_res, data) {
        body = JSON.stringify(data);
      },
      error(_res, message) {
        throw new Error(message);
      },
      readJsonBody: async () => null,
    });

    expect(handled).toBe(true);
    const results = JSON.parse(body).results as Array<{ id: string }>;
    expect(results.map((hit) => hit.id)).toEqual([UPPER]);
  });
});
