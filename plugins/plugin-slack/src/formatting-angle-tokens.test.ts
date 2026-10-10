import { describe, expect, it } from "vitest";
import { markdownToSlackMrkdwn } from "./formatting";

describe("markdownToSlackMrkdwn with Slack link tokens already in the text", () => {
  it("keeps * and ~ in the token URL", () => {
    expect(markdownToSlackMrkdwn("See <https://e.com/a*b*c|docs>")).toBe(
      "See <https://e.com/a*b*c|docs>",
    );
    expect(markdownToSlackMrkdwn("See <https://e.com/a~~b~~c>")).toBe(
      "See <https://e.com/a~~b~~c>",
    );
  });

  it("still styles the label and the text around the token", () => {
    expect(markdownToSlackMrkdwn("<https://x.com|**bold** and *it*>")).toBe(
      "<https://x.com|*bold* and _it_>",
    );
    expect(markdownToSlackMrkdwn("**<https://x.com>**")).toBe(
      "*<https://x.com>*",
    );
    expect(markdownToSlackMrkdwn("<javascript:alert(1)|x>")).toBe(
      "&lt;javascript:alert(1)|x&gt;",
    );
  });
});
