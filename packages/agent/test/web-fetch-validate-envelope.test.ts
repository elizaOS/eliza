/** WEB_FETCH validate must read the user's words, not the document envelope. */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { webFetch } from "../src/runtime/actions/web-fetch.ts";

function envelope(doc: string, user: string): string {
  return [
    "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
    "If the answer appears verbatim in the contextual documents, repeat it exactly.",
    "Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.",
    "",
    "<contextual_documents>",
    `<source title="help.md" similarity="0.900">`,
    doc,
    "</source>",
    "</contextual_documents>",
    "",
    "<user_request>",
    user,
    "</user_request>",
  ].join("\n");
}

function validate(text: string) {
  return webFetch.validate(
    {} as IAgentRuntime,
    { content: { text } } as Memory,
  );
}

describe("webFetch.validate envelope handling", () => {
  it("does not let a document's web-search phrase suppress WEB_FETCH", async () => {
    await expect(
      validate(
        envelope(
          "To get live prices, search the web for the latest price.",
          "what is the price of bitcoin",
        ),
      ),
    ).resolves.toBe(true);
  });

  it("keeps a plain live-info request eligible", async () => {
    await expect(validate("what is the price of bitcoin")).resolves.toBe(true);
  });

  it("preserves a genuine explicit web-search request", async () => {
    await expect(
      validate("search the web for the latest price"),
    ).resolves.toBe(false);
  });

  it("preserves a genuine explicit web-search request inside the envelope", async () => {
    await expect(
      validate(
        envelope("General help text.", "search the web for the latest price"),
      ),
    ).resolves.toBe(false);
  });

  it("keeps a named-URL request eligible even with a document search phrase", async () => {
    await expect(
      validate(
        envelope(
          "To get live prices, search the web for the latest price.",
          "fetch https://api.coingecko.com/api/v3/simple/price?ids=bitcoin",
        ),
      ),
    ).resolves.toBe(true);
  });
});
