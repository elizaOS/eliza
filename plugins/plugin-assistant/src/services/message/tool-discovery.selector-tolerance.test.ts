/** Empty selector arrays count as omitted, and exact names win over a query. */
import type { Action, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { discoveryHarness } from "../__tests__/discovery-harness.ts";

const message = {
  content: { text: "save a note that the gyokuro is in the blue tin" },
} as Memory;

const catalog: Action[] = [
  {
    name: "NOTES_CREATE",
    description: "Create and save a note",
    contexts: ["notes"],
  },
  {
    name: "NOTES_LIST",
    description: "List saved notes",
    contexts: ["notes"],
  },
  {
    name: "CALENDAR_CREATE_EVENT",
    description: "Create a calendar event",
    contexts: ["calendar"],
  },
] as Action[];

describe("empty selector arrays count as omitted", () => {
  it.each([
    ["contexts: [] alone", { contexts: [] }, {}],
    [
      "names: [] beside a query",
      { names: [], query: "create a note" },
      { query: "create a note" },
    ],
  ])("treats %s as the same call without them", async (_label, sent, same) => {
    const tolerant = discoveryHarness(catalog, message);
    const reference = discoveryHarness(catalog, message);
    const result = await tolerant.call(sent);
    expect(result?.success).toBe(true);
    expect(result).toEqual(await reference.call(same));
    expect(tolerant.loads).toEqual(reference.loads);
  });

  it("still loads exact names sent beside a query and contexts", async () => {
    const { call } = discoveryHarness(catalog, message);
    const result = await call({
      names: ["NOTES_LIST"],
      query: "create",
      contexts: ["calendar"],
    });
    expect(result?.success).toBe(true);
    expect(result?.data?.loadedTools).toEqual(["NOTES_LIST"]);
  });
});
