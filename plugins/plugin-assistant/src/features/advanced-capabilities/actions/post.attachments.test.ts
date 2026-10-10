import { validateToolArgs } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { postAction } from "./post.ts";

describe("POST attachments parameter", () => {
  it("accepts media attachment objects for action=send", () => {
    expect(
      validateToolArgs(postAction, {
        action: "send",
        source: "x",
        text: "shipping today",
        attachments: [
          {
            url: "https://example.com/launch.png",
            title: "Launch",
            contentType: "image",
          },
        ],
      }),
    ).toEqual({
      valid: true,
      args: {
        action: "send",
        source: "x",
        text: "shipping today",
        attachments: [
          {
            url: "https://example.com/launch.png",
            title: "Launch",
            contentType: "image",
          },
        ],
      },
      errors: [],
    });
  });

  it("rejects an attachment without a url", () => {
    expect(
      validateToolArgs(postAction, {
        action: "send",
        source: "x",
        text: "shipping today",
        attachments: [{}],
      }),
    ).toEqual({
      valid: false,
      args: undefined,
      errors: ["Missing required argument 'attachments[0].url'"],
      invalidParameterNames: ["attachments"],
    });
  });
});
