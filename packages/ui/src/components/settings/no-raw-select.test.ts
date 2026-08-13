/**
 * Occurrence ratchet for raw `<Select` in the settings surface. A labelled
 * settings select must use SettingsSelectRow. Remaining raw Select sites are
 * recorded by exact count so an extra occurrence in an already-known file
 * fails. Reads files off disk — no render.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsRoot = resolve(import.meta.dirname);

/**
 * Exact remaining raw `<Select` counts (`<Select` followed by space or `>`).
 * Raising a count is a product decision; the default is SettingsSelectRow.
 */
const RAW_SELECT_OCCURRENCES = new Map<
  string,
  { count: number; reason: string }
>([
  [
    "settings-agent-rows.tsx",
    {
      count: 1,
      reason:
        "canonical SettingsSelectRow primitive; it is the one allowed Select owner",
    },
  ],
  [
    "VaultInventoryPanel.tsx",
    {
      count: 1,
      reason:
        "vault add-form category picker lives in a compact custom form, not a settings row",
    },
  ],
  [
    "VoiceProfileSection.tsx",
    {
      count: 1,
      reason:
        "inline relationship chip on the profile row, not a labelled settings select",
    },
  ],
  [
    "vault-tabs/RoutingTab.tsx",
    {
      count: 5,
      reason:
        "routing table cells and default-profile compact picker, not labelled settings rows",
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

function countRawSelects(source: string): number {
  return (source.match(/<Select[\s>]/g) ?? []).length;
}

function rawSelectVerdict(
  relPath: string,
  source: string,
): { ok: true } | { ok: false; message: string } {
  const count = countRawSelects(source);
  const allowed = RAW_SELECT_OCCURRENCES.get(relPath);
  if (!allowed) {
    if (count === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${relPath} has ${count} raw <Select occurrence(s). Use SettingsSelectRow ` +
        `from ./settings-agent-rows, or record the exact remaining count in ` +
        `RAW_SELECT_OCCURRENCES with a reason.`,
    };
  }
  if (count !== allowed.count) {
    return {
      ok: false,
      message:
        `${relPath} has ${count} raw <Select occurrence(s); the ratchet allows ` +
        `${allowed.count} (${allowed.reason}).`,
    };
  }
  return { ok: true };
}

describe("settings controls: raw <Select occurrences are ratcheted", () => {
  const files = listTsxFiles(settingsRoot);

  it.each(files.map((file) => posixRelative(settingsRoot, file)))(
    "%s stays at its recorded raw <Select count",
    (relPath) => {
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      const verdict = rawSelectVerdict(relPath, source);
      expect(verdict.ok, !verdict.ok ? verdict.message : undefined).toBe(true);
    },
  );

  it("documents a reason and exact count for every recorded file", () => {
    for (const [relPath, entry] of RAW_SELECT_OCCURRENCES) {
      expect(entry.reason.trim().length).toBeGreaterThan(8);
      expect(entry.count).toBeGreaterThan(0);
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      expect(countRawSelects(source)).toBe(entry.count);
    }
  });

  it("fails when an already-recorded file gains another raw <Select", () => {
    const source = readFileSync(
      resolve(settingsRoot, "VoiceProfileSection.tsx"),
      "utf8",
    );
    const extra = `${source}\n<Select value="" onValueChange={() => {}} />\n`;
    const verdict = rawSelectVerdict("VoiceProfileSection.tsx", extra);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.message).toContain(
      "has 2 raw <Select occurrence(s); the ratchet allows 1",
    );
  });

  it("fails when a new settings file introduces a raw <Select", () => {
    const verdict = rawSelectVerdict(
      "NewSettingsSection.tsx",
      '<Select value="" onValueChange={() => {}} />',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.message).toContain(
      "has 1 raw <Select occurrence(s)",
    );
  });
});
