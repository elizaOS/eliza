import { isSafeEndpointUrl } from "@elizaos/app-core/platform";
import { describe, expect, it } from "vitest";

describe("isSafeEndpointUrl", () => {
  it("returns true for http://localhost:6080", () => {
    expect(isSafeEndpointUrl("http://localhost:6080")).toBe(true);
  });

  it("returns true for https://example.com/novnc", () => {
    expect(isSafeEndpointUrl("https://example.com/novnc")).toBe(true);
  });

  it("returns false for javascript:alert(1)", () => {
    expect(isSafeEndpointUrl("javascript:alert(1)")).toBe(false);
  });

  it("returns false for data: URL", () => {
    expect(isSafeEndpointUrl("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
  });

  it("returns false for ftp://files.example.com", () => {
    expect(isSafeEndpointUrl("ftp://files.example.com")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isSafeEndpointUrl("")).toBe(false);
  });

  it("returns false for invalid URL (random text)", () => {
    expect(isSafeEndpointUrl("not a url at all")).toBe(false);
  });
});
