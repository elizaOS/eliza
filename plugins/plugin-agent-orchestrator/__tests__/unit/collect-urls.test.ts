import { describe, expect, it } from "vitest";
import { collectUrls } from "../../src/services/orchestrator-task-service.js";

describe("collectUrls", () => {
  it("keeps a parenthesis that closes an opener inside the URL", () => {
    expect(
      collectUrls([
        "see https://en.wikipedia.org/wiki/Mercury_(planet) first",
        "and https://en.wikipedia.org/wiki/Foo_(bar_(baz)).",
        "query https://example.com/?q=a)b_(c)",
      ]),
    ).toEqual([
      "https://en.wikipedia.org/wiki/Mercury_(planet)",
      "https://en.wikipedia.org/wiki/Foo_(bar_(baz))",
      "https://example.com/?q=a)b_(c)",
    ]);
  });

  it("still strips a wrapping parenthesis and trailing punctuation", () => {
    expect(
      collectUrls([
        "docs at https://example.com/docs).",
        "extra https://example.com/a(b)c)",
        "same https://example.com/docs)",
      ]),
    ).toEqual(["https://example.com/docs", "https://example.com/a(b)c"]);
  });
});
