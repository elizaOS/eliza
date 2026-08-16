/**
 * Deterministic coverage for the browser-bundled meeting URL parser, which is
 * intentionally mirrored from @elizaos/shared because view bundles externalize
 * that package at runtime.
 */
import { describe, expect, it } from "vitest";
import { parseMeetingUrl } from "./meeting-url";

describe("calendar view meeting URL parser", () => {
  it("accepts numeric Teams short links on Microsoft and Live hosts", () => {
    expect(
      parseMeetingUrl("https://teams.microsoft.com/meet/123456789?p=abc"),
    ).toMatchObject({ platform: "teams", nativeMeetingId: "123456789" });
    expect(
      parseMeetingUrl("https://teams.live.com/meet/987654321"),
    ).toMatchObject({ platform: "teams", nativeMeetingId: "987654321" });
  });

  it("rejects nonnumeric Teams short-link suffixes instead of truncating them", () => {
    expect(
      parseMeetingUrl("https://teams.microsoft.com/meet/123not-a-meeting"),
    ).toBeNull();
    expect(
      parseMeetingUrl("https://teams.live.com/meet/not-a-meeting"),
    ).toBeNull();
  });
});
