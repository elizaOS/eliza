import { describe, expect, it } from "vitest";
import { extractDocumentUrlFromText } from "./actions.ts";

describe("extractDocumentUrlFromText", () => {
  it("keeps a closing parenthesis that belongs to the URL", () => {
    expect(
      extractDocumentUrlFromText(
        "import https://en.wikipedia.org/wiki/Mercury_(planet).",
      ),
    ).toBe("https://en.wikipedia.org/wiki/Mercury_(planet)");
  });

  it("drops a sentence period and keeps a dot inside the path", () => {
    expect(extractDocumentUrlFromText("see https://example.com/docs.")).toBe(
      "https://example.com/docs",
    );
    expect(extractDocumentUrlFromText("see https://example.com/a.b")).toBe(
      "https://example.com/a.b",
    );
    expect(extractDocumentUrlFromText("see (https://example.com/docs).")).toBe(
      "https://example.com/docs",
    );
  });

  it("stops at an unmatched parenthesis before more text", () => {
    expect(extractDocumentUrlFromText("https://x.com/a),next")).toBe(
      "https://x.com/a",
    );
  });
});
