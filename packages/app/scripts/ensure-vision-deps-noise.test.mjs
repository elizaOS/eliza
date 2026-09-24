/** Verifies installed optional vision tools are silent while failures remain visible. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./ensure-vision-deps.mjs", import.meta.url),
  "utf8",
);

describe("ensure-vision-deps startup output", () => {
  it("does not announce tools that were already installed", () => {
    expect(source).not.toMatch(
      /dim\("(?:imagesnap|fswebcam|ffmpeg) installed"\)/,
    );
  });

  it("retains actionable missing-tool and install-failure output", () => {
    expect(source).toMatch(/Install manually: brew install imagesnap/);
    expect(source).toMatch(/Install manually: sudo apt-get install fswebcam/);
    expect(source).toMatch(/Failed to install ffmpeg/);
  });
});
