import type { Memory } from "@elizaos/core";
import { expect, it } from "vitest";
import { channelTopicSearchAction } from "./channel-topic-search.ts";

// Shape packages/agent/src/api/chat-augmentation.ts writes into
// content.text: the help fragments wrap the real request in a
// <user_request> block. Without unwrapping, the whole envelope becomes
// the channel topic search query instead of the user's request.
function augmented(request: string): string {
  return [
    "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
    "",
    "<contextual_documents>",
    '<source title="doc" similarity="0.900">Eliza is an autonomous agent powered by elizaOS.</source>',
    "</contextual_documents>",
    "",
    "<user_request>",
    request,
    "</user_request>",
  ].join("\n");
}

async function runQuery(text: string): Promise<string> {
  const captured: string[] = [];
  const service = {
    searchTopics: (query: string) => {
      captured.push(query);
      return [];
    },
  };
  const runtime = {
    getService: (name: string) => (name === "channel_topics" ? service : null),
  } as unknown as Parameters<
    NonNullable<typeof channelTopicSearchAction.handler>
  >[0];
  const message = { content: { text } } as Memory;
  await channelTopicSearchAction.handler?.(runtime, message, undefined, {});
  return captured[0] ?? "";
}

it("derives the query from the request inside the help-document envelope", async () => {
  const plain = await runQuery(
    "which channels have been talking about workouts",
  );
  const wrapped = await runQuery(
    augmented("which channels have been talking about workouts"),
  );
  expect(wrapped).toBe(plain);
  expect(wrapped).not.toContain("Answer the user request");
  expect(wrapped).not.toContain("<user_request>");
});
