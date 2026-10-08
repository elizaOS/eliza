import { describe, expect, it } from "vitest";
import { isSafeAttachmentUrl } from "./attachment-url";

describe("isSafeAttachmentUrl", () => {
  it("rejects a slash-backslash path that browsers send to another site", () => {
    const url = "/\\evil.example/phish";
    expect(new URL(url, "https://app.example/").origin).toBe(
      "https://evil.example",
    );
    expect(isSafeAttachmentUrl(url)).toBe(false);
    expect(isSafeAttachmentUrl("/api/media/abc")).toBe(true);
  });
});
