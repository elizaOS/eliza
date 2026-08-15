/**
 * Occurrence ratchet for raw `<Switch` in the settings surface. A labelled
 * boolean settings row must use SettingsSwitchRow. Remaining raw Switch sites
 * are recorded by exact count so an extra occurrence in an already-known file
 * fails. Reads files off disk — no render.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsRoot = resolve(import.meta.dirname);

/**
 * Exact remaining raw `<Switch` counts. Raising a count is a product decision;
 * the default is SettingsSwitchRow.
 */
const RAW_SWITCH_OCCURRENCES = new Map<
  string,
  { count: number; reason: string }
>([
  [
    "settings-agent-rows.tsx",
    {
      count: 1,
      reason:
        "canonical SettingsSwitchRow primitive; it is the one allowed Switch owner",
    },
  ],
  [
    "AdvancedToggle.tsx",
    {
      count: 1,
      reason: "compact inline disclosure control, not a labelled settings row",
    },
  ],
  [
    "VoiceConfigView.tsx",
    {
      count: 1,
      reason:
        "compact enable switch inside a custom status chip, not a SettingsRow",
    },
  ],
]);

function posixRelative(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/");
}

function listTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listTsxFiles(full));
    } else if (
      name.endsWith(".tsx") &&
      !name.endsWith(".test.tsx") &&
      !name.endsWith(".stories.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

function countRawSwitches(source: string): number {
  return (source.match(/<Switch[\s>]/g) ?? []).length;
}

function rawSwitchVerdict(
  relPath: string,
  source: string,
): { ok: true } | { ok: false; message: string } {
  const count = countRawSwitches(source);
  const allowed = RAW_SWITCH_OCCURRENCES.get(relPath);
  if (!allowed) {
    if (count === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${relPath} has ${count} raw <Switch occurrence(s). Use SettingsSwitchRow ` +
        `from ./settings-agent-rows, or record the exact remaining count in ` +
        `RAW_SWITCH_OCCURRENCES with a reason.`,
    };
  }
  if (count !== allowed.count) {
    return {
      ok: false,
      message:
        `${relPath} has ${count} raw <Switch occurrence(s); the ratchet allows ` +
        `${allowed.count} (${allowed.reason}).`,
    };
  }
  return { ok: true };
}

describe("settings controls: raw <Switch occurrences are ratcheted", () => {
  const files = listTsxFiles(settingsRoot);

  it.each(files.map((file) => posixRelative(settingsRoot, file)))(
    "%s stays at its recorded raw <Switch count",
    (relPath) => {
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      const verdict = rawSwitchVerdict(relPath, source);
      expect(verdict.ok, !verdict.ok ? verdict.message : undefined).toBe(true);
    },
  );

  it("documents a reason and exact count for every recorded file", () => {
    for (const [relPath, entry] of RAW_SWITCH_OCCURRENCES) {
      expect(entry.reason.trim().length).toBeGreaterThan(8);
      expect(entry.count).toBeGreaterThan(0);
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      expect(countRawSwitches(source)).toBe(entry.count);
    }
  });

  it("fails when an already-recorded file gains another raw <Switch", () => {
    const source = readFileSync(
      resolve(settingsRoot, "AdvancedToggle.tsx"),
      "utf8",
    );
    const extra = `${source}\n<Switch checked={false} onCheckedChange={() => {}} />\n`;
    const verdict = rawSwitchVerdict("AdvancedToggle.tsx", extra);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.message).toContain(
      "has 2 raw <Switch occurrence(s); the ratchet allows 1",
    );
  });

  it("fails when a new settings file introduces a raw <Switch", () => {
    const verdict = rawSwitchVerdict(
      "NewSettingsSection.tsx",
      "<Switch checked={false} onCheckedChange={() => {}} />",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.message).toContain(
      "has 1 raw <Switch occurrence(s)",
    );
  });
});
