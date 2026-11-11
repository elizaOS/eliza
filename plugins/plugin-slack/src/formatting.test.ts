/** Slack mrkdwn conversion keeps bare URLs as the address the agent wrote. */
import { parseFenceSpans } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { chunkSlackText, markdownToSlackMrkdwn } from "./formatting";

describe("markdownToSlackMrkdwn bare URLs", () => {
  it("keeps * and _ inside a URL as part of the URL", () => {
    expect(markdownToSlackMrkdwn("Raw https://example.com/a*b*c link")).toBe(
      "Raw <https://example.com/a*b*c> link",
    );
    expect(
      markdownToSlackMrkdwn("Go to https://example.com/_private_/page now"),
    ).toBe("Go to <https://example.com/_private_/page> now");
  });

  it("leaves emphasis and punctuation around a URL outside it", () => {
    expect(markdownToSlackMrkdwn("*see https://example.com/x*")).toBe(
      "_see <https://example.com/x>_",
    );
    expect(markdownToSlackMrkdwn("Read https://example.com/a?b=1&c=2.")).toBe(
      "Read <https://example.com/a?b=1&amp;c=2>.",
    );
  });

  it("keeps a | inside a URL, sent as %7C like a Markdown link", () => {
    expect(
      markdownToSlackMrkdwn("See https://example.com/redirect?u=a|b now"),
    ).toBe("See <https://example.com/redirect?u=a%7Cb> now");
  });

  it("does not change URLs that are already Slack or Markdown links", () => {
    expect(markdownToSlackMrkdwn("<https://example.com/a|guide>")).toBe(
      "<https://example.com/a|guide>",
    );
    expect(markdownToSlackMrkdwn("[guide](https://example.com/a_b)")).toBe(
      "<https://example.com/a_b|guide>",
    );
  });
});

describe("markdown links in inline code", () => {
  it("keeps examples literal while converting links outside code", () => {
    expect(
      markdownToSlackMrkdwn(
        "Read `[docs](https://example.com)` then [visit](https://example.org)",
      ),
    ).toBe(
      "Read `[docs](https://example.com)` then <https://example.org|visit>",
    );
    expect(
      markdownToSlackMrkdwn(
        "`[one](https://one.test)` and `[two](https://two.test)`",
      ),
    ).toBe("`[one](https://one.test)` and `[two](https://two.test)`");
  });

  it("keeps emphasis markers in a code link example literal", () => {
    expect(markdownToSlackMrkdwn("`[a*b*c](https://example.com/x)`")).toBe(
      "`[a*b*c](https://example.com/x)`",
    );
  });

  it("still converts a link whose label is inline code", () => {
    expect(markdownToSlackMrkdwn("[`y`](https://e.com)")).toBe(
      "<https://e.com|`y`>",
    );
  });
});

describe("chunkSlackText fenced code blocks", () => {
  const codeLines = (count: number): string[] =>
    Array.from(
      { length: count },
      (_, i) => `line ${String(i).padStart(2, "0")} of code here`,
    );

  /** Lines of one chunk that sit inside a backtick fenced block. */
  function fencedLines(chunk: string): Set<string> {
    const spans = parseFenceSpans(`${chunk}\n`).filter((span) =>
      span.marker.startsWith("`"),
    );
    const inside = new Set<string>();
    let offset = 0;
    for (const line of chunk.split("\n")) {
      const lineStart = offset;
      if (
        spans.some((span) => lineStart > span.start && lineStart < span.end)
      ) {
        inside.add(line);
      }
      offset += line.length + 1;
    }
    return inside;
  }

  /** Every chunk leaves no backtick block open at its end. */
  function expectBalancedFences(chunks: string[]) {
    for (const chunk of chunks) {
      const spans = parseFenceSpans(`${chunk}\n`).filter((span) =>
        span.marker.startsWith("`"),
      );
      const last = spans.at(-1);
      expect(last === undefined || last.end <= chunk.length).toBe(true);
    }
  }

  it("keeps a ```js line inside the block instead of closing it", () => {
    const lines = codeLines(24);
    const text = [
      "```",
      ...lines.slice(0, 10),
      "```js",
      ...lines.slice(10),
      "```",
    ].join("\n");
    const chunks = chunkSlackText(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expectBalancedFences(chunks);
    // The code after the ```js line still travels inside a fenced chunk,
    // and the original closer still closes a block.
    const fenced = new Set(chunks.flatMap((chunk) => [...fencedLines(chunk)]));
    for (const line of lines) {
      expect(fenced.has(line)).toBe(true);
    }
    expect(fenced.has("```js")).toBe(true);
  });

  it("keeps a plain fenced block fenced across chunks", () => {
    const lines = codeLines(24);
    const text = ["```", ...lines, "```"].join("\n");
    const chunks = chunkSlackText(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expectBalancedFences(chunks);
    const fenced = new Set(chunks.flatMap((chunk) => [...fencedLines(chunk)]));
    for (const line of lines) {
      expect(fenced.has(line)).toBe(true);
    }
  });
});
