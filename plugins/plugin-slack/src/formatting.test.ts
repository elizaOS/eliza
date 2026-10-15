/** Slack mrkdwn conversion keeps bare URLs as the address the agent wrote. */
import { describe, expect, it } from "vitest";
import { markdownToSlackMrkdwn } from "./formatting";

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
