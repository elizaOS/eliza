import { describe, expect, it } from "vitest";
import { markdownToSlackMrkdwn } from "./formatting";

describe("markdownToSlackMrkdwn bold italic", () => {
  it("nests italic inside bold for ***text***", () => {
    expect(markdownToSlackMrkdwn("***both***")).toBe("*_both_*");
    expect(markdownToSlackMrkdwn("a ***key point*** here")).toBe(
      "a *_key point_* here",
    );
  });

  it("leaves bold, italic and a spaced *** unchanged", () => {
    expect(markdownToSlackMrkdwn("**b** and *i*")).toBe("*b* and _i_");
    expect(markdownToSlackMrkdwn("2 *** 3")).toBe("2 *** 3");
  });
});
