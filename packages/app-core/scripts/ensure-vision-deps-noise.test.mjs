/** Verifies installed optional vision tools are silent while failures remain visible. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(
  new URL("./ensure-vision-deps.mjs", import.meta.url),
  "utf8",
);

describe("ensure-vision-deps startup output", () => {
  it("does not announce tools that were already installed", () => {
    assert.doesNotMatch(
      source,
      /dim\("(?:imagesnap|fswebcam|ffmpeg) installed"\)/,
    );
  });

  it("retains actionable missing-tool and install-failure output", () => {
    assert.match(source, /Install manually: brew install imagesnap/);
    assert.match(source, /Install manually: sudo apt-get install fswebcam/);
    assert.match(source, /Failed to install ffmpeg/);
  });
});
