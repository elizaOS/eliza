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

  it("rejects a control character between slashes that browsers drop", () => {
    for (const url of [
      "/\t/evil.example/p",
      "/\n/evil.example/p",
      "/\r\\evil.example",
    ]) {
      expect(new URL(url, "https://app.example/").origin).toBe(
        "https://evil.example",
      );
      expect(isSafeAttachmentUrl(url)).toBe(false);
    }
  });
});
