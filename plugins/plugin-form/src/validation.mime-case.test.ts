/** Media types are case-insensitive. A capital accept pattern must still match. */
import { describe, expect, it } from "vitest";
import { matchesMimeType } from "./validation.ts";

describe("matchesMimeType", () => {
  it("matches a file type when the accept pattern uses different case", () => {
    expect(matchesMimeType("image/png", "IMAGE/*")).toBe(true);
    expect(matchesMimeType("Image/PNG", "image/png")).toBe(true);
  });

  it("still rejects a different type", () => {
    expect(matchesMimeType("image/png", "IMAGE/JPEG")).toBe(false);
    expect(matchesMimeType("text/plain", "IMAGE/*")).toBe(false);
    expect(matchesMimeType("application/pdf", "image/*")).toBe(false);
  });
});
