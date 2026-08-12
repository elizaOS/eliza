/**
 * Slack mrkdwn formatting helpers. Escaping &, <, > is required so user text
 * can't forge Slack control sequences (mentions/links); the mention/link
 * builders and their extractors must round-trip; and markdown→mrkdwn must use
 * Slack's *bold* / _italic_ syntax rather than the markdown originals.
 */
import { describe, expect, it } from "vitest";
import {
  buildSlackMessagePermalink,
  chunkSlackText,
  escapeSlackMrkdwn,
  extractChannelIdFromMention,
  extractUrlFromSlackLink,
  extractUserIdFromMention,
  formatSlackChannelMention,
  formatSlackLink,
  formatSlackSpecialMention,
  formatSlackUserGroupMention,
  formatSlackUserMention,
  markdownToSlackMrkdwn,
  parseSlackMessagePermalink,
  stripSlackFormatting,
  truncateText,
} from "./formatting.ts";

describe("escapeSlackMrkdwn", () => {
  it("escapes the three Slack control chars, leaves clean text untouched", () => {
    expect(escapeSlackMrkdwn("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeSlackMrkdwn("plain text")).toBe("plain text");
  });
});

describe("markdownToSlackMrkdwn", () => {
  it("converts bold/italic/strikethrough to Slack syntax", () => {
    expect(markdownToSlackMrkdwn("**bold**")).toBe("*bold*");
    expect(markdownToSlackMrkdwn("*italic*")).toBe("_italic_");
    expect(markdownToSlackMrkdwn("~~struck~~")).toBe("~struck~");
    expect(markdownToSlackMrkdwn("")).toBe("");
  });
});

describe("mention builders + extractors round-trip", () => {
  it("user mention", () => {
    const m = formatSlackUserMention("U12345");
    expect(m).toBe("<@U12345>");
    expect(extractUserIdFromMention(m)).toBe("U12345");
    expect(extractUserIdFromMention("not a mention")).toBeNull();
  });

  it("channel mention", () => {
    const m = formatSlackChannelMention("C0ABCDE");
    expect(m).toBe("<#C0ABCDE>");
    expect(extractChannelIdFromMention(m)).toBe("C0ABCDE");
  });

  it("group + special mentions", () => {
    expect(formatSlackUserGroupMention("S123")).toBe("<!subteam^S123>");
    expect(formatSlackSpecialMention("channel")).toBe("<!channel>");
  });
});

describe("links", () => {
  it("formats with optional label and extracts the url back", () => {
    expect(formatSlackLink("https://x.com")).toBe("<https://x.com>");
    expect(formatSlackLink("https://x.com", "X")).toBe("<https://x.com|X>");
    expect(extractUrlFromSlackLink("<https://x.com|X>")).toBe("https://x.com");
    expect(extractUrlFromSlackLink("<slack://channel?id=C123|Channel>")).toBe(
      "slack://channel?id=C123",
    );
    expect(extractUrlFromSlackLink("<mailto:alice@example.com>")).toBe(
      "mailto:alice@example.com",
    );
    expect(extractUrlFromSlackLink("nope")).toBeNull();
  });
});

describe("stripSlackFormatting", () => {
  it("removes mrkdwn markup, mentions, and unescapes entities", () => {
    expect(stripSlackFormatting("*bold* and _it_ and <@U1> hi")).toBe(
      "bold and it and  hi",
    );
    expect(stripSlackFormatting("a &amp; b")).toBe("a & b");
  });

  it("unwraps plain links to their URL instead of deleting them", () => {
    expect(stripSlackFormatting("see <https://a.com> ok")).toBe(
      "see https://a.com ok",
    );
    expect(stripSlackFormatting("open <slack://channel?id=C1> ok")).toBe(
      "open slack://channel?id=C1 ok",
    );
  });

  it("strips every link, not just the first", () => {
    expect(
      stripSlackFormatting("<https://a.com|A> and <https://b.com|B>"),
    ).toBe("A and B");
    expect(stripSlackFormatting("<https://a.com> and <https://b.com>")).toBe(
      "https://a.com and https://b.com",
    );
    expect(
      stripSlackFormatting("<mailto:alice@ex.com|Email> and <tel:+1234567>"),
    ).toBe("Email and tel:+1234567");
  });
});

describe("chunkSlackText", () => {
  it("never emits a chunk over the limit, even when closing a split code block", () => {
    const text = `\`\`\`\n${"x".repeat(4200)}\n\`\`\``;
    const chunks = chunkSlackText(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4000)).toBe(true);
    // the split chunk is fence-closed and the remainder fence-reopened
    expect(chunks[0].endsWith("\n```")).toBe(true);
    expect(chunks[1].startsWith("```\n")).toBe(true);
  });

  it("does not fence-close a code block that only opens after the break point", () => {
    // Newline break lands at 2795; the opening fence sits between the break
    // point and the maxChars window, so the emitted chunk contains no fence.
    const text = `${"line\n".repeat(559)}\`\`\`${"x".repeat(300)}\n\`\`\`\n`;
    const chunks = chunkSlackText(text, 3000);
    expect(chunks.every((c) => c.length <= 3000)).toBe(true);
    // no chunk may carry an odd number of fences (a half-open code block)
    for (const c of chunks) {
      expect((c.match(/```/g) || []).length % 2).toBe(0);
    }
  });
});

describe("truncateText", () => {
  it("appends ellipsis only when over the limit", () => {
    expect(truncateText("short", 10)).toBe("short");
    expect(truncateText("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("permalink build/parse round-trip", () => {
  it("encodes and decodes channel + message timestamp", () => {
    const url = buildSlackMessagePermalink(
      "acme",
      "C0ABCDE",
      "1234567890.123456",
    );
    expect(url).toBe(
      "https://acme.slack.com/archives/C0ABCDE/p1234567890123456",
    );
    expect(parseSlackMessagePermalink(url)).toEqual({
      workspaceDomain: "acme",
      channelId: "C0ABCDE",
      messageTs: "1234567890.123456",
    });
    expect(parseSlackMessagePermalink("https://acme.example.com/x")).toBeNull();
  });

  it("parses user DM channel permalinks and non-fractional 10-digit timestamps", () => {
    expect(
      parseSlackMessagePermalink(
        "https://acme.slack.com/archives/U1234567/p1700000000123456",
      ),
    ).toEqual({
      workspaceDomain: "acme",
      channelId: "U1234567",
      messageTs: "1700000000.123456",
    });

    expect(
      parseSlackMessagePermalink(
        "https://acme.slack.com/archives/C0ABCDE/p1700000000",
      ),
    ).toEqual({
      workspaceDomain: "acme",
      channelId: "C0ABCDE",
      messageTs: "1700000000",
    });
  });

  it("returns null for malformed short timestamps", () => {
    expect(
      parseSlackMessagePermalink(
        "https://acme.slack.com/archives/C0ABCDE/p12345",
      ),
    ).toBeNull();
  });
});
