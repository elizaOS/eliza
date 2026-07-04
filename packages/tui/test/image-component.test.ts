/**
 * Exercises the Image component's degrade path over the real render pipeline —
 * no mocks: capability detection is driven by env vars and the actual PNG header
 * parser decides whether dimensions are known. Guards #12739: undeterminable
 * dimensions must render a distinguishable text placeholder, never a
 * fabricated-size graphic that corrupts differential-render height accounting.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "vitest";
import { Image } from "../src/components/image.js";
import { resetCapabilitiesCache } from "../src/terminal-image.js";

const KITTY_ENV_KEYS = ["KITTY_WINDOW_ID", "TERM_PROGRAM"] as const;

// A minimal PNG whose IHDR reports 120x80 — enough bytes for getPngDimensions.
const VALID_PNG_B64 = "iVBORwAAAAAAAAAAAAAAAAAAAHgAAABQ";
// 24 zero bytes: long enough to pass the length guard, wrong signature -> null.
const CORRUPT_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const theme = { fallbackColor: (s: string) => s };

function forceKittyCapabilities(): void {
  process.env.KITTY_WINDOW_ID = "1";
  resetCapabilitiesCache();
}

describe("Image degrade states (#12739)", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of KITTY_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    resetCapabilitiesCache();
  });

  afterEach(() => {
    for (const key of KITTY_ENV_KEYS) {
      const prev = saved.get(key);
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
    resetCapabilitiesCache();
  });

  it("renders a distinguishable text placeholder when dimensions are unknown, even on an image-capable terminal", () => {
    forceKittyCapabilities();

    const image = new Image(CORRUPT_B64, "image/png", theme, {
      filename: "broken.png",
    });
    const lines = image.render(80);

    // Degrade must be a single text line, not a multi-row graphical sequence.
    assert.strictEqual(lines.length, 1);
    assert.ok(
      lines[0].includes("[Image:") && lines[0].includes("broken.png"),
      `expected text placeholder, got: ${JSON.stringify(lines[0])}`,
    );
    // The Kitty/iTerm2 graphical escape must NOT be emitted for unknown dims.
    assert.ok(
      !lines[0].includes("\x1b_G") && !lines[0].includes("\x1b]1337;File="),
      "unknown-dimension image must not emit a graphical protocol sequence",
    );
  });

  it("never fabricates a size (no 800x600) in the placeholder for unknown dimensions", () => {
    forceKittyCapabilities();

    const image = new Image(CORRUPT_B64, "image/jpeg", theme, {
      filename: "corrupt.jpg",
    });
    const [line] = image.render(80);

    // imageFallback omits the size when dimensions are undefined; the old code
    // substituted a fabricated { widthPx: 800, heightPx: 600 } here.
    assert.ok(
      !/\d+x\d+/.test(line),
      `placeholder must not contain a fabricated pixel size, got: ${JSON.stringify(line)}`,
    );
  });

  it("renders the graphical protocol path when dimensions are known", () => {
    forceKittyCapabilities();

    const image = new Image(VALID_PNG_B64, "image/png", theme, {
      maxWidthCells: 40,
    });
    const lines = image.render(80);

    // Known dimensions on a Kitty terminal produce a real image sequence, and
    // the component pads with (rows-1) empty lines for height accounting.
    const joined = lines.join("");
    assert.ok(
      joined.includes("\x1b_G"),
      "known-dimension image on a Kitty terminal must emit a Kitty sequence",
    );
    assert.ok(
      !joined.includes("[Image:"),
      "known-dimension image must not degrade to the text placeholder",
    );
  });

  it("degrades to the text placeholder on a non-image terminal regardless of dimensions", () => {
    // No image env keys set -> detectCapabilities() reports images: null.
    resetCapabilitiesCache();

    const image = new Image(VALID_PNG_B64, "image/png", theme, {
      filename: "photo.png",
    });
    const lines = image.render(80);

    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes("[Image:") && lines[0].includes("photo.png"));
  });
});
