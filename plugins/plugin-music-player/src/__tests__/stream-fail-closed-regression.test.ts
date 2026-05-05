import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const streamFallbackSource = readFileSync(
  path.resolve(import.meta.dirname, "..", "utils", "streamFallback.ts"),
  "utf-8",
);
const queueSource = readFileSync(
  path.resolve(import.meta.dirname, "..", "queue.ts"),
  "utf-8",
);

describe("music playback fail-closed regressions", () => {
  it("uses a single canonical stream extractor", () => {
    expect(streamFallbackSource).not.toContain("createYtdlCoreStream");
    expect(streamFallbackSource).not.toContain("play.stream(");
    expect(streamFallbackSource).toMatch(/source:\s*["']yt-dlp["']/);
  });

  it("does not search or retry alternative tracks after stream failures", () => {
    expect(queueSource).not.toContain("track:age-restricted");
    expect(queueSource).not.toContain("alternative version");
    expect(queueSource).not.toContain("selectBestAlternativeTrack");
    expect(queueSource).toMatch(
      /lastErrorMessage\s*\|\|\s*["']No playable source found["']/,
    );
  });
});
