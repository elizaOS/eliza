/**
 * Occurrence ratchet for raw `<Input` in the settings surface. A labelled
 * text/password field must use SettingsInputRow. Remaining raw Input sites
 * are recorded by exact count so an extra occurrence in an already-known
 * file fails. Reads files off disk — no render.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsRoot = resolve(import.meta.dirname);

/**
 * Exact remaining raw `<Input` counts. Raising a count is a product decision;
 * the default is SettingsInputRow. A new occurrence in any of these files
 * fails until the count is deliberately updated.
 */
const RAW_INPUT_OCCURRENCES = new Map<
  string,
  { count: number; reason: string }
>([
  [
    "AdvancedSection.tsx",
    {
      count: 1,
      reason: "radio list of backup files, not a labelled text field",
    },
  ],
  [
    "BackgroundSettingsControls.tsx",
    {
      count: 1,
      reason:
        "hidden file picker for wallpaper upload, not a labelled text field",
    },
  ],
  [
    "CloudAgentsSection.tsx",
    {
      count: 2,
      reason: "inline rename and create-name fields sit beside action buttons",
    },
  ],
  [
    "cloud-panel/sections/AgentSection.tsx",
    {
      count: 2,
      reason: "inline rename and create-name fields sit beside action buttons",
    },
  ],
  [
    "SubscriptionStatus.tsx",
    {
      count: 2,
      reason:
        "billing/checkout form fields live in a custom card, not a settings row",
    },
  ],
  [
    "VaultInventoryPanel.tsx",
    {
      count: 8,
      reason:
        "vault credential editor is a custom multi-field form, not a settings row",
    },
  ],
  [
    "VoiceConfigView.tsx",
    {
      count: 3,
      reason: "compact wake-word and device fields inside a custom status chip",
    },
  ],
  [
    "VoiceProfileSection.tsx",
    {
      count: 1,
      reason:
        "inline rename field; remaining Label usages are merge/sample checkboxes",
    },
  ],
  [
    "VoiceSection.tsx",
    {
      count: 1,
      reason: "end-of-turn range sliders, not labelled text/password fields",
    },
  ],
  [
    "vault-tabs/LoginsTab.tsx",
    {
      count: 4,
      reason:
        "vault login editor is a custom multi-field form, not a settings row",
    },
  ],
  [
    "vault-tabs/OverviewTab.tsx",
    {
      count: 7,
      reason:
        "vault overview editor is a custom multi-field form, not a settings row",
    },
  ],
  [
    "vault-tabs/RoutingTab.tsx",
    {
      count: 2,
      reason:
        "vault routing editor is a custom multi-field form, not a settings row",
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

function countRawInputs(source: string): number {
  return source.split("<Input").length - 1;
}

function rawInputVerdict(
  relPath: string,
  source: string,
): { ok: true } | { ok: false; message: string } {
  const count = countRawInputs(source);
  const allowed = RAW_INPUT_OCCURRENCES.get(relPath);
  if (!allowed) {
    if (count === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${relPath} has ${count} raw <Input occurrence(s). Use SettingsInputRow ` +
        `from ./settings-agent-rows, or record the exact remaining count in ` +
        `RAW_INPUT_OCCURRENCES with a reason.`,
    };
  }
  if (count !== allowed.count) {
    return {
      ok: false,
      message:
        `${relPath} has ${count} raw <Input occurrence(s); the ratchet allows ` +
        `${allowed.count} (${allowed.reason}).`,
    };
  }
  return { ok: true };
}

describe("settings controls: raw <Input occurrences are ratcheted", () => {
  const files = listTsxFiles(settingsRoot);

  it.each(files.map((file) => posixRelative(settingsRoot, file)))(
    "%s stays at its recorded raw <Input count",
    (relPath) => {
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      const verdict = rawInputVerdict(relPath, source);
      expect(verdict.ok, !verdict.ok ? verdict.message : undefined).toBe(true);
    },
  );

  it("documents a reason and exact count for every recorded file", () => {
    for (const [relPath, entry] of RAW_INPUT_OCCURRENCES) {
      expect(entry.reason.trim().length).toBeGreaterThan(8);
      expect(entry.count).toBeGreaterThan(0);
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      expect(countRawInputs(source)).toBe(entry.count);
    }
  });

  it("fails when an already-recorded file gains another raw <Input", () => {
    const source = readFileSync(
      resolve(settingsRoot, "VoiceProfileSection.tsx"),
      "utf8",
    );
    const extra = `${source}\n<Input value="" onChange={() => {}} />\n`;
    const verdict = rawInputVerdict("VoiceProfileSection.tsx", extra);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.message).toContain(
      "has 2 raw <Input occurrence(s); the ratchet allows 1",
    );
  });

  it("fails when a new settings file introduces a raw <Input", () => {
    const verdict = rawInputVerdict(
      "NewSettingsSection.tsx",
      '<Input value="" onChange={() => {}} />',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.message).toContain(
      "has 1 raw <Input occurrence(s)",
    );
  });
});
