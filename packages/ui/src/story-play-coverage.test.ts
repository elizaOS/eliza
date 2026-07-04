/**
 * Coverage gate asserting every story ships a play function (interaction
 * coverage). Reads the stories tree, no runtime.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Storybook interaction-coverage ratchet (issue #9943).
 *
 * The story gate (`test/story-gate/run-story-gate.mjs`) is render-smoke only —
 * it proves a story MOUNTS, not that the component WORKS. ~91% of stories are
 * render-only with no `play`. This guard makes interaction coverage a forward
 * ratchet instead of permanently advisory:
 *
 *   1. The total number of stories exporting a `play` (an interaction test that
 *      drives clicks/fills/state and asserts) may only GROW. Adding an
 *      interactive component without a `play` cannot lower the floor; removing a
 *      `play` from any story fails this test. Raise `MIN_INTERACTION_PLAYS` when
 *      you add plays so the floor tracks reality.
 *   2. A curated set of high-traffic interactive components MUST always ship a
 *      `play`. Deleting the interaction test from any of these fails CI — the
 *      exact "an interactive story shipped without a play" regression #9943 calls
 *      out. Extend `REQUIRED_PLAY` as more components get real interaction tests.
 *
 * Source-level (no Storybook build needed) so it runs in the fast unit lane.
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/** A story exports an interaction test when it has a top-level `play:` / `play =`. */
const PLAY_RE = /^[ \t]*play[ \t]*[:=]/m;

function listStoryFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listStoryFiles(full));
    } else if (entry.endsWith(".stories.tsx")) {
      out.push(full);
    }
  }
  return out;
}

function exportsPlay(absPath: string): boolean {
  return PLAY_RE.test(readFileSync(absPath, "utf8"));
}

// Floor: stories that currently export a `play`. RATCHET — only ever raise this.
const MIN_INTERACTION_PLAYS = 14;

// High-traffic interactive components whose interaction test must never be
// dropped. Paths are relative to packages/ui/src. Grow this list as components
// gain real plays (chat composer, settings forms, command palette, springboard …).
const REQUIRED_PLAY = [
  "components/shell/ShortcutsOverlay.stories.tsx", // keyboard shortcuts overlay
  "components/shell/RestartBanner.stories.tsx", // shell restart banner
  "components/pages/Launcher.stories.tsx", // springboard / app launcher
  "components/chat/widgets/needs-attention.stories.tsx", // home attention widget
  "components/composites/chat/chat-message-actions.stories.tsx", // chat message actions
] as const;

describe("Storybook interaction coverage (#9943)", () => {
  const storyFiles = listStoryFiles(SRC_DIR);
  const withPlay = storyFiles.filter(exportsPlay);

  it("discovers the story corpus", () => {
    // Guard against a glob/path regression silently passing the ratchet on zero
    // files — the suite is large.
    expect(storyFiles.length).toBeGreaterThan(100);
  });

  it("never regresses below the interaction-play floor (ratchet up only)", () => {
    expect(withPlay.length).toBeGreaterThanOrEqual(MIN_INTERACTION_PLAYS);
  });

  it("requires an interaction `play` on every high-traffic interactive component", () => {
    const missing = REQUIRED_PLAY.filter((rel) => {
      const abs = path.join(SRC_DIR, rel);
      return !exportsPlay(abs);
    });
    expect(missing).toEqual([]);
  });
});
