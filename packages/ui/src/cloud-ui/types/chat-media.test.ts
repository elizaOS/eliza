/**
 * Unit tests for chat media: validates ContentType enum-like values.
 */
import { describe, expect, it } from "vitest";
import { ContentType } from "./chat-media.ts";

describe("chat-media", () => {
  it("exports standard ContentType values", () => {
    expect(ContentType.IMAGE).toBe("image");
    expect(ContentType.VIDEO).toBe("video");
    expect(ContentType.AUDIO).toBe("audio");
    expect(ContentType.DOCUMENT).toBe("document");
    expect(ContentType.LINK).toBe("link");
  });
});
