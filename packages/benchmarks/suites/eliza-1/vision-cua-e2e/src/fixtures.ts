/**
 * Fixture loader for the eliza-1 vision + CUA E2E harness.
 *
 * Three fixtures are shipped:
 *   - `single-1920x1080`           — one display, FHD.
 *   - `ultra-wide-5120x1440`       — one ultra-wide panel exercising the tiler.
 *   - `multi-display-composite`    — two displays (1920x1080 + 2560x1440)
 *                                    delivered as separate captures.
 *
 * Each fixture has a `frame.png` (the "before" capture) and a
 * `frame-after.png` (the "after" capture used to detect a state change in
 * stub mode). When the matching PNGs are missing, we synthesise them on the
 * fly by calling `generate-fixtures.mjs`. This keeps the harness runnable on
 * a fresh checkout without committing megabytes of test PNGs.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DisplayCaptureFixture, DisplayConfig } from "./types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "fixtures");

export type FixtureId =
  | "single-1920x1080"
  | "ultra-wide-5120x1440"
  | "multi-display-composite";

interface FixtureSpec {
  readonly id: FixtureId;
  readonly description: string;
  readonly displays: ReadonlyArray<
    DisplayConfig & { readonly assetDir: string }
  >;
}

const FIXTURES: ReadonlyArray<FixtureSpec> = [
  {
    id: "single-1920x1080",
    description: "Single FHD desktop (1920x1080).",
    displays: [
      {
        id: 1,
        name: "primary-1920x1080",
        bounds: [0, 0, 1920, 1080],
        scaleFactor: 1,
        primary: true,
        assetDir: "single-1920x1080/display-1",
      },
    ],
  },
  {
    id: "ultra-wide-5120x1440",
    description: "Ultra-wide single display (5120x1440).",
    displays: [
      {
        id: 1,
        name: "ultra-wide-5120x1440",
        bounds: [0, 0, 5120, 1440],
        scaleFactor: 1,
        primary: true,
        assetDir: "ultra-wide-5120x1440/display-1",
      },
    ],
  },
  {
    id: "multi-display-composite",
    description:
      "Two displays — 1920x1080 primary and 2560x1440 secondary side by side.",
    displays: [
      {
        id: 1,
        name: "primary-1920x1080",
        bounds: [0, 0, 1920, 1080],
        scaleFactor: 1,
        primary: true,
        assetDir: "multi-display-composite/display-1",
      },
      {
        id: 2,
        name: "secondary-2560x1440",
        bounds: [1920, 0, 2560, 1440],
        scaleFactor: 1,
        primary: false,
        assetDir: "multi-display-composite/display-2",
      },
    ],
  },
];

export function listFixtures(): ReadonlyArray<FixtureId> {
  return FIXTURES.map((f) => f.id);
}

function getFixtureSpec(id: FixtureId): FixtureSpec {
  const spec = FIXTURES.find((f) => f.id === id);
  if (!spec) {
    throw new Error(`getFixtureSpec: unknown fixture '${id}'`);
  }
  return spec;
}

export interface LoadedFixture {
  readonly id: FixtureId;
  readonly description: string;
  readonly captures: ReadonlyArray<DisplayCaptureFixture>;
}

/**
 * Load a fixture from disk. If the PNGs are missing, the caller is expected
 * to have run `bun run fixtures:generate` first; otherwise this throws with
 * a clear message.
 */
export function loadFixture(id: FixtureId): LoadedFixture {
  const spec = getFixtureSpec(id);
  const captures: DisplayCaptureFixture[] = spec.displays.map((display) => {
    const before = join(FIXTURE_ROOT, display.assetDir, "frame.png");
    const after = join(FIXTURE_ROOT, display.assetDir, "frame-after.png");
    if (!existsSync(before) || !existsSync(after)) {
      throw new Error(
        `loadFixture: missing PNGs at ${before} / ${after}. Run \`bun run fixtures:generate\` first.`,
      );
    }
    return {
      display: {
        id: display.id,
        name: display.name,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor,
        primary: display.primary,
      },
      frame: new Uint8Array(readFileSync(before)),
      frameAfter: new Uint8Array(readFileSync(after)),
    };
  });
  return {
    id: spec.id,
    description: spec.description,
    captures,
  };
}
