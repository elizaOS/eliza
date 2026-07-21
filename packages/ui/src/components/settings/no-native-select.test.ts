/**
 * Static source-scan guard: fails if any `.tsx` under settings/ (plus
 * RoutingMatrix) hand-rolls a raw `<select>` instead of the canonical settings
 * controls. Reads files off disk — no render. Rationale below.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #8793: native `<select>` is mobile-hostile — on iOS/Android it opens the OS
// wheel/sheet, ignores the app theme, and gives no search for long lists ("the
// options are a whole page away"). The settings surface ships canonical, themed,
// 44px-touch, agent-addressable controls instead — `SettingsSelectRow`
// (Radix sheet-style select) and `SettingsSegmentedRow` (segmented control).
// This guard fails CI if a new raw `<select>` is hand-rolled under settings, so
// the regression can never creep back in.

const settingsRoot = resolve(import.meta.dirname);
// RoutingMatrix lives outside settings/ but is part of the same surface and was
// part of the same cleanup; guard it too.
const extraGuardedFiles = [
  resolve(settingsRoot, "../local-inference/RoutingMatrix.tsx"),
];

function listTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listTsxFiles(full));
    } else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("settings controls: no native <select>", () => {
  const files = [...listTsxFiles(settingsRoot), ...extraGuardedFiles];

  it.each(
    files.map((f) => relative(settingsRoot, f)),
  )("%s uses canonical settings controls, not a raw <select>", (relPath) => {
    const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
    expect(
      source.includes("<select"),
      `${relPath} hand-rolls a native <select>. Use SettingsSelectRow ` +
        `(Radix sheet select) or SettingsSegmentedRow (segmented control) ` +
        `from ./settings-agent-rows instead — they are themed, 44px-touch, ` +
        `and agent-addressable.`,
    ).toBe(false);
  });
});
