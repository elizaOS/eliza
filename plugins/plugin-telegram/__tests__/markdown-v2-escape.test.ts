import { describe, expect, it } from "vitest";
import { convertMarkdownToTelegram } from "../src/utils";

describe("convertMarkdownToTelegram mid-line '>'", () => {
  it("escapes '>' that follows code, bold, a link or an escaped star", () => {
    expect(convertMarkdownToTelegram("if `count`>5 stop")).toBe(
      "if `count`\\>5 stop",
    );
    expect(convertMarkdownToTelegram("**Step 1**>> next")).toBe(
      "*Step 1*\\>\\> next",
    );
    expect(convertMarkdownToTelegram("[docs](https://x.y)> more")).toBe(
      "[docs](https://x.y)\\> more",
    );
    expect(convertMarkdownToTelegram("a \\*>b")).toBe("a \\*\\>b");
  });

  it("keeps blockquote markers at the start of a line", () => {
    expect(convertMarkdownToTelegram("> quote **b** more")).toBe(
      "> quote *b* more",
    );
    expect(convertMarkdownToTelegram("**x**\n> q")).toBe("*x*\n> q");
    expect(convertMarkdownToTelegram("> a\n> **b**> c")).toBe(
      "> a\n> *b*\\> c",
    );
  });
});

describe("convertMarkdownToTelegram incomplete code blocks", () => {
  it("retains code content and emits a closed Telegram code entity", () => {
    expect(convertMarkdownToTelegram("```python\n# comment\nx ** 2")).toBe(
      "```python\n# comment\nx ** 2```",
    );
    expect(convertMarkdownToTelegram("```\nline\n")).toBe("```\nline\n```");
    expect(convertMarkdownToTelegram("```js\r\nconst x = `hi`;")).toBe(
      "```js\nconst x = \\`hi\\`;```",
    );
    expect(convertMarkdownToTelegram("```py\n# comment\n```")).toBe(
      "```py\n# comment\n```",
    );
    expect(convertMarkdownToTelegram("**Heading**\n```sh\necho text")).toBe(
      "*Heading*\n```sh\necho text```",
    );
    expect(convertMarkdownToTelegram("```js\na\n```\n```py\n# b")).toBe(
      "```js\na\n```\n```py\n# b```",
    );
  });
});

describe("convertMarkdownToTelegram bare URLs", () => {
  it("keeps underscores and asterisks inside a URL as part of the URL", () => {
    expect(
      convertMarkdownToTelegram("Go to https://example.com/_private_/page now"),
    ).toBe("Go to https://example\\.com/\\_private\\_/page now");
    expect(
      convertMarkdownToTelegram("Raw https://example.com/a*b*c link"),
    ).toBe("Raw https://example\\.com/a\\*b\\*c link");
  });

  it("leaves emphasis and punctuation around a URL outside it", () => {
    expect(convertMarkdownToTelegram("*see https://example.com/x*")).toBe(
      "_see https://example\\.com/x_",
    );
    expect(convertMarkdownToTelegram("Read https://example.com/a_b.")).toBe(
      "Read https://example\\.com/a\\_b\\.",
    );
    expect(
      convertMarkdownToTelegram(
        "Wiki https://en.wikipedia.org/wiki/Test_(x) ok",
      ),
    ).toBe("Wiki https://en\\.wikipedia\\.org/wiki/Test\\_\\(x\\) ok");
  });
});
