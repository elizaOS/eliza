import type { Memory } from "@elizaos/core";
import { expect, it } from "vitest";
import { impliedTriggerQuery } from "../src/actions/trigger.ts";

// Shape packages/agent/src/api/chat-augmentation.ts writes into
// content.text: the help fragments wrap the real request in a
// <user_request> block. Without unwrapping, the first clause is the
// preamble, which has no trigger verb, so the query resolves to nothing.
function augmented(request: string): string {
  return [
    "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
    "If the answer appears verbatim in the contextual documents, repeat it exactly.",
    "Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.",
    "",
    "<contextual_documents>",
    '<source title="source-1" similarity="0.790">',
    "Eliza is an autonomous agent powered by elizaOS, the agent framework. Users can ask Eliza to write code, add new skills, and run recurring workflows on scheduled triggers.",
    "</source>",
    "</contextual_documents>",
    "",
    "<user_request>",
    request,
    "</user_request>",
  ].join("\n");
}

function messageFor(text: string): Memory {
  return { content: { text } } as Memory;
}

it("reads the request inside the help-document envelope", () => {
  expect(impliedTriggerQuery(messageFor("Delete the landlord trigger."))).toBe(
    "landlord",
  );
  expect(
    impliedTriggerQuery(messageFor(augmented("Delete the landlord trigger."))),
  ).toBe("landlord");
  expect(
    impliedTriggerQuery(messageFor(augmented("Cancel my gym reminder."))),
  ).toBe("gym");
});
