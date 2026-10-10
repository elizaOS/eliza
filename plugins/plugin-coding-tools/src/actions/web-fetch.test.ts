import { describe, expect, it } from "vitest";
import { htmlToReadableText } from "./web-fetch.js";

describe("htmlToReadableText", () => {
  it("keeps a space the page wrote before punctuation", () => {
    expect(htmlToReadableText("<p><code>git add .</code></p>")).toBe(
      "git add .",
    );
    expect(
      htmlToReadableText(
        "<p><code>cd ..</code> then <code>ls -la .</code></p>",
      ),
    ).toBe("cd .. then ls -la .");
  });

  it("does not leave a space where an inline tag meets punctuation", () => {
    expect(htmlToReadableText('<p>See <a href="/x">this link</a>.</p>')).toBe(
      "See this link.",
    );
  });

  it("decodes numeric references the way browsers do", () => {
    expect(htmlToReadableText("<p>Don&#146;t &#151; A&#X41;B</p>")).toBe(
      "Don’t — AAB",
    );
  });
});
