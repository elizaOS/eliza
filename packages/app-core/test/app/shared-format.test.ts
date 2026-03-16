import {
  autoLabel,
  formatByteSize,
  formatDateTime,
  formatDurationMs,
  formatShortDate,
  formatTime,
} from "@elizaos/app-core/components";
import { describe, expect, it } from "vitest";

describe("shared format helpers", () => {
  it("formats bytes with readable units", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatByteSize(1024 ** 3)).toBe("1.0 GB");
  });

  it("formats durations", () => {
    expect(formatDurationMs(12_000)).toBe("12s");
    expect(formatDurationMs(90_000)).toBe("2m");
    expect(formatDurationMs(3_600_000)).toBe("1h");
    expect(formatDurationMs(90_000_000)).toBe("1.0d");
    expect(formatDurationMs(0, { fallback: "n/a" })).toBe("n/a");
  });

  it("formats date and short-date values", () => {
    const value = "2026-02-13T00:00:00.000Z";

    expect(formatDateTime(value, { locale: "en-US" })).toContain("2026");
    expect(formatShortDate(value, { locale: "en-US" })).toContain("2026");
    expect(formatTime(value, { locale: "en-US" })).toContain(":");
  });
});

describe("shared labels", () => {
  it("normalizes plugin env keys with prefix stripping", () => {
    expect(autoLabel("MY_PLUGIN_API_KEY", "my-plugin")).toBe("API Key");
    expect(autoLabel("MYPLUGIN_SECRET_TOKEN", "my-plugin")).toBe(
      "Secret Token",
    );
    expect(autoLabel("PLAIN_KEY", "any-plugin")).toBe("Plain Key");
  });
});
