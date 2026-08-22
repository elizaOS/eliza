/**
 * Coverage gate asserting every story ships a play function (interaction
 * coverage). Reads the stories tree, no runtime.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Requires interaction tests on the explicitly supported high-traffic stories. */

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

  it("discovers the story corpus", () => {
    // Guard against a glob/path regression silently passing on zero files.
    expect(storyFiles.length).toBeGreaterThan(100);
  });

  it("requires an interaction `play` on every high-traffic interactive component", () => {
    const missing = REQUIRED_PLAY.filter((rel) => {
      const abs = path.join(SRC_DIR, rel);
      return !exportsPlay(abs);
    });
    expect(missing).toEqual([]);
  });
});
