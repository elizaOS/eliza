/**
 * Slack mrkdwn formatting helpers. Escaping &, <, > is required so user text
 * can't forge Slack control sequences (mentions/links); the mention/link
 * builders and their extractors must round-trip; date and permalink helpers
 * must reject malformed boundary values; and markdown→mrkdwn must use Slack's
 * *bold* / _italic_ syntax rather than the markdown originals.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildSlackMessagePermalink,
  chunkSlackText,
  escapeSlackMrkdwn,
  extractChannelIdFromMention,
  extractUrlFromSlackLink,
  extractUserIdFromMention,
  formatSlackChannelMention,
  formatSlackDate,
  formatSlackLink,
  formatSlackSpecialMention,
  formatSlackUserGroupMention,
  formatSlackUserMention,
  markdownToSlackMrkdwn,
  parseSlackMessagePermalink,
  splitSlackText,
  stripSlackFormatting,
  truncateText,
} from "./formatting.ts";
import { isValidMessageTs, parseSlackMessageLink } from "./types.ts";

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
  it("respects the limit when the break character lands exactly on the fence budget", () => {
    // lastIndexOf is inclusive of its fromIndex, so a newline sitting exactly
    // on hardLimit (maxChars - 4) used to push breakPoint one past it and
    // spend the reserved "\n```" budget, emitting maxChars + 1.
    const text = `\`\`\`\n${"a".repeat(3992)}\n${"b".repeat(500)}`;
    const chunks = chunkSlackText(text, 4000);
    expect(chunks.every((c) => c.length <= 4000)).toBe(true);
  });

  it("respects a small limit at the same boundary", () => {
    const text = `\`\`\`\n${"a".repeat(92)}\n${"b".repeat(120)}`;
    const chunks = chunkSlackText(text, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
  });

  it("holds the limit across a sweep of break positions", () => {
    for (let pad = 3980; pad <= 3999; pad++) {
      const text = `\`\`\`\n${"a".repeat(pad)}\n${"b".repeat(200)}`;
      const chunks = chunkSlackText(text, 4000);
      expect(chunks.every((c) => c.length <= 4000)).toBe(true);
    }
  });

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

  it("never splits an emoji surrogate pair across chunks on a break-free run", () => {
    // "a" (1 unit) + 150 astral emoji (2 units each, no spaces/newlines) puts
    // the hardLimit=96 break point (maxChars=100) exactly between the high
    // and low surrogate of the 47th emoji, forcing the raw-slice fallback.
    const text = `a${"😀".repeat(150)}`;
    const chunks = chunkSlackText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.isWellFormed())).toBe(true);
    expect(chunks.every((c) => c.length > 0 && c.length <= 100)).toBe(true);
    // lossless: no unit dropped or duplicated at the surrogate-adjusted cut
    expect(chunks.join("")).toBe(text);
  });

  it("fails closed instead of exceeding maxChars when a surrogate pair can't fit", () => {
    // Widening past maxChars=1 to fit the pair would silently break the
    // "never emits more than maxChars" contract every other test here checks.
    let thrown: unknown;
    try {
      chunkSlackText("😀", 1);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    expect((thrown as ElizaError).code).toBe("SLACK_CHUNK_LIMIT_TOO_SMALL");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects an invalid maxChars (%s) instead of silently coercing it",
    (maxChars) => {
      let thrown: unknown;
      try {
        chunkSlackText("hello", maxChars);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ElizaError);
      expect((thrown as ElizaError).code).toBe("SLACK_CHUNK_LIMIT_INVALID");
    },
  );
});

describe("splitSlackText", () => {
  it.each(["\n", " "])(
    "keeps the service send path within the cap at an exact %j boundary",
    (boundary) => {
      const text = `${"a".repeat(4000)}${boundary}${"b".repeat(100)}`;
      const chunks = splitSlackText(text, 4000);

      expect(chunks.map((chunk) => chunk.length)).toEqual([4000, 101]);
      expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
      expect(chunks.join("")).toBe(text);
    },
  );

  it("never splits an emoji surrogate pair across chunks on a break-free run", () => {
    // "a" (1 unit) + 150 astral emoji puts the maxChars=100 cut exactly
    // between the high and low surrogate of the 49th emoji.
    const text = `a${"😀".repeat(150)}`;
    const chunks = splitSlackText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.isWellFormed())).toBe(true);
    expect(chunks.every((c) => c.length > 0 && c.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("fails closed instead of exceeding maxChars when a surrogate pair can't fit", () => {
    let thrown: unknown;
    try {
      splitSlackText("😀", 1);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    expect((thrown as ElizaError).code).toBe("SLACK_CHUNK_LIMIT_TOO_SMALL");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects an invalid maxChars (%s) instead of silently coercing it",
    (maxChars) => {
      let thrown: unknown;
      try {
        splitSlackText("hello", maxChars);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ElizaError);
      expect((thrown as ElizaError).code).toBe("SLACK_CHUNK_LIMIT_INVALID");
    },
  );
});

describe("truncateText", () => {
  it("appends ellipsis only when over the limit", () => {
    expect(truncateText("short", 10)).toBe("short");
    expect(truncateText("abcdefghij", 5)).toBe("abcd…");
  });

  it("keeps UTF-16 surrogate pairs intact across the truncation boundary", () => {
    // 5 single-unit chars + 2-unit emoji (🦊 \uD83E\uDD8A) + trailing chars
    // maxLength 7, ellipsis length 1 -> budget 6.
    // Index 5-6 is 🦊. Slicing at 6 would split the surrogate pair.
    // truncateWellFormed backs off to 5 ("hello") so the emoji is not split.
    const text = "hello🦊world";
    const truncated = truncateText(text, 7);

    expect(truncated).toBe("hello…");
    expect(truncated.isWellFormed()).toBe(true);
  });

  it("sanitizes pre-existing lone surrogates before truncating", () => {
    const text = "a\ud800bcdef";
    const truncated = truncateText(text, 4);

    expect(truncated).toBe("a\ufffdb…");
    expect(truncated.isWellFormed()).toBe(true);
  });

  it("handles custom ellipsis string and boundaries", () => {
    expect(truncateText("hello world", 8, "...")).toBe("hello...");
    expect(truncateText("hello world", 2, "...")).toBe("..");
  });

  it.each([
    { maxLength: 0, ellipsis: "...", expected: "" },
    { maxLength: 1, ellipsis: "😀", expected: "h" },
    { maxLength: 2, ellipsis: "😀", expected: "😀" },
    { maxLength: 1, ellipsis: "\ud800", expected: "�" },
  ])(
    "bounds and sanitizes ellipsis $ellipsis at maxLength=$maxLength",
    ({ maxLength, ellipsis, expected }) => {
      const truncated = truncateText("hello world", maxLength, ellipsis);

      expect(truncated).toBe(expected);
      expect(truncated.length).toBeLessThanOrEqual(maxLength);
      expect(truncated.isWellFormed()).toBe(true);
    },
  );

  it("never exceeds maxLength for oversized custom ellipses", () => {
    for (const maxLength of [0, 1, 2]) {
      const truncated = truncateText("hello world", maxLength, "😀...");
      expect(truncated.length).toBeLessThanOrEqual(maxLength);
      expect(truncated.isWellFormed()).toBe(true);
    }
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
    const parsed16 = parseSlackMessagePermalink(
      "https://acme.slack.com/archives/U1234567/p1700000000123456",
    );
    expect(parsed16).toEqual({
      workspaceDomain: "acme",
      channelId: "U1234567",
      messageTs: "1700000000.123456",
    });
    expect(isValidMessageTs(parsed16?.messageTs ?? "")).toBe(true);

    const parsed10 = parseSlackMessagePermalink(
      "https://acme.slack.com/archives/C0ABCDE/p1700000000",
    );
    expect(parsed10).toEqual({
      workspaceDomain: "acme",
      channelId: "C0ABCDE",
      messageTs: "1700000000.000000",
    });
    expect(isValidMessageTs(parsed10?.messageTs ?? "")).toBe(true);
  });

  it("normalizes Slack's documented 15-digit chat.getPermalink examples", () => {
    const documented = parseSlackMessagePermalink(
      "https://ghostbusters.slack.com/archives/C1H9RESGA/p135854651500008",
    );
    expect(documented).toEqual({
      workspaceDomain: "ghostbusters",
      channelId: "C1H9RESGA",
      messageTs: "1358546515.000008",
    });
    expect(isValidMessageTs(documented?.messageTs ?? "")).toBe(true);

    const threaded = parseSlackMessagePermalink(
      "https://ghostbusters.slack.com/archives/C1H9RESGL/p135854651700023?thread_ts=1358546515.000008&cid=C1H9RESGL",
    );
    expect(threaded).toEqual({
      workspaceDomain: "ghostbusters",
      channelId: "C1H9RESGL",
      messageTs: "1358546517.000023",
    });
    expect(isValidMessageTs(threaded?.messageTs ?? "")).toBe(true);
  });

  it("returns null for malformed timestamps, wrong lengths, or trailing garbage", () => {
    expect(
      parseSlackMessagePermalink(
        "https://acme.slack.com/archives/C0ABCDE/p12345",
      ),
    ).toBeNull();
    expect(
      parseSlackMessagePermalink(
        "https://acme.slack.com/archives/C0ABCDE/p17000000001",
      ),
    ).toBeNull(); // 11 digits
    expect(
      parseSlackMessagePermalink(
        "https://acme.slack.com/archives/C0ABCDE/p17000000001234",
      ),
    ).toBeNull(); // 14 digits
    expect(
      parseSlackMessagePermalink(
        "https://acme.slack.com/archives/C0ABCDE/p17000000001234567",
      ),
    ).toBeNull(); // 17 digits
    expect(
      parseSlackMessagePermalink(
        "https://acme.slack.com/archives/C0ABCDE/p1700000000123456evil",
      ),
    ).toBeNull(); // trailing garbage
    expect(
      parseSlackMessagePermalink(
        "https://acme.slack.com/archives/C0ABCDE/p1700000000123456/evil",
      ),
    ).toBeNull();
  });

  // Both exports resolve the origin through the same WHATWG `URL` boundary, so
  // every case here is asserted against both. Textual patterns kept admitting
  // whichever delimiter had not been banned yet: excluding `.` left `/` open,
  // and excluding `/` too still left `?`, `#`, and `\`. Each entry below is a
  // string a regex over the raw link reads as Slack while `new URL(...)`
  // resolves it to a non-Slack host.
  describe.each([
    ["parseSlackMessagePermalink", parseSlackMessagePermalink],
    ["parseSlackMessageLink", parseSlackMessageLink],
  ])("%s host boundary", (_name, parse) => {
    it.each([
      // Delimiters that terminate the authority before the `.slack.com` text.
      [
        "query delimiter",
        "https://attacker?x=.slack.com/archives/C12345678/p1700000000123456",
      ],
      [
        "fragment delimiter",
        "https://attacker#x=.slack.com/archives/C12345678/p1700000000123456",
      ],
      [
        "WHATWG backslash delimiter",
        "https://attacker\\redirect.slack.com/archives/C12345678/p1700000000123456",
      ],
      [
        "path delimiter",
        "https://attacker/redirect.slack.com/archives/C12345678/p1700000000123456",
      ],
      [
        "path delimiter on a hyphenated host",
        "https://evil-host/a.slack.com/archives/C12345678/p1700000000123456",
      ],
      // `user@evil.slack.com` reached a real Slack host, but reported the
      // attacker-controlled userinfo as the workspace domain, which then
      // round-trips back out through `buildSlackMessagePermalink`.
      [
        "userinfo",
        "https://user@evil.slack.com/archives/C12345678/p1700000000123456",
      ],
      [
        "userinfo with password",
        "https://user:pw@acme.slack.com/archives/C12345678/p1700000000123456",
      ],
      [
        "port",
        "https://acme.slack.com:8080/archives/C12345678/p1700000000123456",
      ],
      // Percent-encoded separators must not be decoded back into structure.
      [
        "encoded host delimiter",
        "https://attacker%2F.slack.com/archives/C12345678/p1700000000123456",
      ],
      [
        "encoded path delimiter in the channel segment",
        "https://acme.slack.com/archives/C12345678%2Fx/p1700000000123456",
      ],
      // Lookalike hosts: the suffix has to be the end of the host, and the
      // workspace has to be a real label in front of it.
      [
        "suffix continues into another domain",
        "https://acme.slack.com.evil.com/archives/C12345678/p1700000000123456",
      ],
      [
        "slack.com without a workspace label",
        "https://slack.com/archives/C12345678/p1700000000123456",
      ],
      [
        "empty workspace label",
        "https://.slack.com/archives/C12345678/p1700000000123456",
      ],
      [
        "lookalike registrable domain",
        "https://acme.slack.com.co/archives/C12345678/p1700000000123456",
      ],
      [
        "unrelated host",
        "https://evil.example/archives/C12345678/p1700000000123456",
      ],
      // Non-HTTP schemes never carry an `/archives/` permalink.
      [
        "non-HTTP scheme",
        "javascript:alert(1)//acme.slack.com/archives/C12345678/p1700000000123456",
      ],
      [
        "file scheme",
        "file://acme.slack.com/archives/C12345678/p1700000000123456",
      ],
    ])("rejects %s", (_case, link) => {
      expect(parse(link)).toBeNull();
    });
  });

  // Consequences of resolving with `URL` rather than matching the raw string.
  // Both inputs name a genuine `acme.slack.com` message and every real client
  // resolves them to it, so they are accepted deliberately, not incidentally.
  it("resolves links the way a URL parser does once the host is genuinely Slack", () => {
    expect(
      parseSlackMessagePermalink(
        "https://acme.slack.com\\archives\\C12345678\\p1700000000123456",
      ),
    ).toEqual({
      workspaceDomain: "acme",
      channelId: "C12345678",
      messageTs: "1700000000.123456",
    });
    expect(
      parseSlackMessagePermalink(
        "https://acme.slack.com/x/../archives/C12345678/p1700000000123456",
      ),
    ).toEqual({
      workspaceDomain: "acme",
      channelId: "C12345678",
      messageTs: "1700000000.123456",
    });
  });

  it("normalizes host case and accepts hyphenated workspace labels", () => {
    expect(
      parseSlackMessagePermalink(
        "https://My-Team.SLACK.COM/archives/C12345678/p1700000000123456",
      ),
    ).toEqual({
      workspaceDomain: "my-team",
      channelId: "C12345678",
      messageTs: "1700000000.123456",
    });
  });

  it("keeps the channel contracts the two parsers actually need", () => {
    // The permalink form is used for display and round-tripping, so it accepts
    // any ID shape; the link form feeds conversation APIs and so requires a
    // conversation ID.
    const userChannel =
      "https://acme.slack.com/archives/U1234567/p1700000000123456";
    expect(parseSlackMessagePermalink(userChannel)).toEqual({
      workspaceDomain: "acme",
      channelId: "U1234567",
      messageTs: "1700000000.123456",
    });
    expect(parseSlackMessageLink(userChannel)).toBeNull();
  });
});

describe("formatSlackDate", () => {
  it("formats valid Date or timestamp into Slack <!date...>", () => {
    const d = new Date(1700000000000);
    expect(formatSlackDate(d)).toBe(
      "<!date^1700000000^{date_short_pretty} at {time}|2023-11-14T22:13:20.000Z>",
    );
  });

  it("degrades instead of throwing on unrepresentable timestamps", () => {
    // Previously `new Date(NaN).toISOString()` threw RangeError out of a
    // formatting helper; out-of-range epoch millis are the same failure.
    expect(formatSlackDate(new Date("invalid"))).toBe("Invalid date");
    expect(formatSlackDate(Infinity)).toBe("Invalid date");
    expect(formatSlackDate(8_640_000_000_000_001, "{date}", "Fallback")).toBe(
      "Fallback",
    );
  });
});

describe("parseSlackMessageLink", () => {
  it("parses valid archives links and normalizes messageTs to satisfy isValidMessageTs", () => {
    const res16 = parseSlackMessageLink(
      "https://acme.slack.com/archives/C12345678/p1700000000123456",
    );
    expect(res16).toEqual({
      channelId: "C12345678",
      messageTs: "1700000000.123456",
    });
    expect(isValidMessageTs(res16?.messageTs ?? "")).toBe(true);

    const res10 = parseSlackMessageLink(
      "https://acme.slack.com/archives/C12345678/p1700000000",
    );
    expect(res10).toEqual({
      channelId: "C12345678",
      messageTs: "1700000000.000000",
    });
    expect(isValidMessageTs(res10?.messageTs ?? "")).toBe(true);

    const documented = parseSlackMessageLink(
      "https://ghostbusters.slack.com/archives/C1H9RESGA/p135854651500008",
    );
    expect(documented).toEqual({
      channelId: "C1H9RESGA",
      messageTs: "1358546515.000008",
    });
    expect(isValidMessageTs(documented?.messageTs ?? "")).toBe(true);

    const threaded = parseSlackMessageLink(
      "https://ghostbusters.slack.com/archives/C1H9RESGL/p135854651700023?thread_ts=1358546515.000008&cid=C1H9RESGL",
    );
    expect(threaded).toEqual({
      channelId: "C1H9RESGL",
      messageTs: "1358546517.000023",
    });
    expect(isValidMessageTs(threaded?.messageTs ?? "")).toBe(true);
  });

  it("requires a bare permalink, and round-trips the mrkdwn-wrapped form via extractUrlFromSlackLink", () => {
    const bare = "https://acme.slack.com/archives/C12345678/p1700000000123456";
    // parseSlackMessageLink substring-matched before anchoring, so these three
    // used to parse; parseSlackMessagePermalink was already start-anchored and
    // is pinned here so both helpers now agree on rejecting a non-bare link.
    expect(parseSlackMessageLink(`<${bare}|jump to message>`)).toBeNull();
    expect(parseSlackMessageLink(`see ${bare} for context`)).toBeNull();
    expect(parseSlackMessagePermalink(`<${bare}>`)).toBeNull();

    const extracted = extractUrlFromSlackLink(`<${bare}|jump to message>`);
    expect(extracted).toBe(bare);
    expect(parseSlackMessageLink(extracted ?? "")).toEqual({
      channelId: "C12345678",
      messageTs: "1700000000.123456",
    });
  });

  it("returns null for malformed lengths, invalid digits, or trailing garbage", () => {
    expect(
      parseSlackMessageLink("https://acme.slack.com/archives/C12345678/p123"),
    ).toBeNull();
    expect(
      parseSlackMessageLink(
        "https://acme.slack.com/archives/C12345678/p17000000001",
      ),
    ).toBeNull(); // 11 digits
    expect(
      parseSlackMessageLink(
        "https://acme.slack.com/archives/C12345678/p17000000001234",
      ),
    ).toBeNull(); // 14 digits
    expect(
      parseSlackMessageLink(
        "https://acme.slack.com/archives/C12345678/p17000000001234567",
      ),
    ).toBeNull(); // 17 digits
    expect(
      parseSlackMessageLink(
        "https://acme.slack.com/archives/C12345678/p1700000000123456evil",
      ),
    ).toBeNull(); // trailing garbage
    expect(
      parseSlackMessageLink(
        "https://evil.example/archives/C12345678/p1700000000123456",
      ),
    ).toBeNull();
    expect(
      parseSlackMessageLink(
        "https://acme.slack.com/archives/C12345678/p1700000000123456/evil",
      ),
    ).toBeNull();
  });
});
