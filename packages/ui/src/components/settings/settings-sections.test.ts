/**
 * Exercises `settings-sections.ts`'s own logic: the catalog/META drift guard,
 * the display grouping shared by the Settings nav and the folded section strip,
 * and the two i18n label helpers.
 *
 * `assertMetaCatalogParity`'s docstring says it "is asserted by a focused
 * test". There was no such test — this file is it. The guard also runs once at
 * module load, so importing this module is what enforces the invariant at app
 * boot; calling it directly keeps that reachable from a test runner instead of
 * only from a boot-time side effect.
 *
 * Deterministic and pure — no rendering, no DOM, no runtime.
 */
import { describe, expect, it } from "vitest";
import { registerSettingsGroup } from "../../cloud/settings/cloud-settings-group";
import { SETTINGS_SECTION_META } from "./settings-section-meta";
import type { SettingsSectionDef } from "./settings-section-registry";
import {
  assertMetaCatalogParity,
  groupSettingsSections,
  SETTINGS_GROUP_LABEL,
  SETTINGS_GROUP_ORDER,
  SETTINGS_SECTIONS,
  settingsSectionLabel,
  settingsSectionTitle,
} from "./settings-sections";

const Noop = (): null => null;

function section(over: Partial<SettingsSectionDef> = {}): SettingsSectionDef {
  return {
    id: "one",
    label: "settings.one.label",
    defaultLabel: "One",
    icon: Noop as unknown as SettingsSectionDef["icon"],
    tone: "accent" as SettingsSectionDef["tone"],
    hue: "accent",
    titleKey: "settings.one.title",
    defaultTitle: "One Title",
    group: "agent",
    Component: Noop,
    ...over,
  } as SettingsSectionDef;
}

describe("assertMetaCatalogParity", () => {
  // The focused test the docstring promises. It cannot fail today — the data
  // is in parity — which is the point: it fails the moment a catalog
  // definition and the pure-data META list drift, in a test run rather than
  // only when something imports the module at boot.
  it("passes on the shipped catalog", () => {
    expect(() => assertMetaCatalogParity()).not.toThrow();
  });

  // Independent restatement of the same invariant, so a regression is visible
  // as a diff of ids rather than as a thrown string from a boot-time side
  // effect. `SETTINGS_SECTIONS` is the catalog subset in display order.
  it("keeps the catalog subset aligned with META in id and order", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(
      SETTINGS_SECTION_META.map((m) => m.id),
    );
  });

  it.each(["defaultLabel", "group"] as const)(
    "keeps every catalog section's %s aligned with META",
    (field) => {
      const metaById = new Map(SETTINGS_SECTION_META.map((m) => [m.id, m]));
      for (const s of SETTINGS_SECTIONS) {
        expect({ id: s.id, [field]: s[field] }).toEqual({
          id: s.id,
          [field]: metaById.get(s.id)?.[field],
        });
      }
    },
  );

  it("keeps aliases aligned with META, in order", () => {
    const metaById = new Map(SETTINGS_SECTION_META.map((m) => [m.id, m]));
    for (const s of SETTINGS_SECTIONS) {
      expect([...(s.aliases ?? [])]).toEqual([
        ...(metaById.get(s.id)?.aliases ?? []),
      ]);
    }
  });
});

describe("groupSettingsSections", () => {
  it("orders built-in groups by SETTINGS_GROUP_ORDER, not by input order", () => {
    const reversed = [...SETTINGS_GROUP_ORDER]
      .reverse()
      .map((group, index) => section({ id: `s${index}`, group }));
    expect(groupSettingsSections(reversed).map((g) => g.group)).toEqual([
      ...SETTINGS_GROUP_ORDER,
    ]);
  });

  it("labels built-in groups from SETTINGS_GROUP_LABEL", () => {
    const grouped = groupSettingsSections(
      SETTINGS_GROUP_ORDER.map((group, index) =>
        section({ id: `s${index}`, group }),
      ),
    );
    for (const entry of grouped) {
      expect(entry.label).toBe(
        SETTINGS_GROUP_LABEL[entry.group as keyof typeof SETTINGS_GROUP_LABEL],
      );
    }
  });

  // "A section whose group is neither built-in nor registered falls into an
  // 'Other' bucket so it is never dropped." Both halves matter: the label is
  // literally "Other" (not the raw group id), and the bucket sorts last.
  it('labels an unregistered group "Other" and sorts it last', () => {
    const grouped = groupSettingsSections([
      section({ id: "mystery", group: "totally-unregistered" }),
      section({ id: "agentish", group: "agent" }),
    ]);
    const other = grouped.at(-1);
    expect(other?.group).toBe("totally-unregistered");
    expect(other?.label).toBe("Other");
    expect(other?.items.map((i) => i.id)).toEqual(["mystery"]);
    expect(grouped[0]?.group).toBe("agent");
  });

  // A registered extra group is interleaved by its declared order — the whole
  // reason the function consults the extra-group registry rather than only the
  // pinned list. Order 0.5 must land between the first and second built-ins.
  it("interleaves a registered extra group by its order", () => {
    registerSettingsGroup({
      id: "test-extra-group",
      label: "Test Extra",
      order: 0.5,
    });
    const grouped = groupSettingsSections([
      section({ id: "extra", group: "test-extra-group" }),
      ...SETTINGS_GROUP_ORDER.map((group, index) =>
        section({ id: `s${index}`, group }),
      ),
    ]);
    const ids = grouped.map((g) => g.group);
    expect(ids[0]).toBe(SETTINGS_GROUP_ORDER[0]);
    expect(ids[1]).toBe("test-extra-group");
    expect(ids[2]).toBe(SETTINGS_GROUP_ORDER[1]);
    expect(grouped.find((g) => g.group === "test-extra-group")?.label).toBe(
      "Test Extra",
    );
  });

  it("preserves input order within a bucket", () => {
    const grouped = groupSettingsSections([
      section({ id: "b", group: "agent" }),
      section({ id: "a", group: "agent" }),
      section({ id: "c", group: "agent" }),
    ]);
    expect(grouped[0]?.items.map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("returns no buckets for no sections", () => {
    expect(groupSettingsSections([])).toEqual([]);
  });
});

describe("the i18n label helpers pass their English fallback", () => {
  // `t` receives `defaultValue` so a missing translation renders English
  // rather than the raw key. Recording the options argument is the only way to
  // see that — a `t` that ignores its second argument looks identical.
  it("passes defaultLabel as defaultValue to t", () => {
    const calls: [string, unknown][] = [];
    const t = (key: string, vars?: Record<string, unknown>): string => {
      calls.push([key, vars]);
      return "translated";
    };
    expect(settingsSectionLabel(section(), t)).toBe("translated");
    expect(calls).toEqual([["settings.one.label", { defaultValue: "One" }]]);
  });

  it("passes defaultTitle as defaultValue to t", () => {
    const calls: [string, unknown][] = [];
    const t = (key: string, vars?: Record<string, unknown>): string => {
      calls.push([key, vars]);
      return "translated";
    };
    expect(settingsSectionTitle(section(), t)).toBe("translated");
    expect(calls).toEqual([
      ["settings.one.title", { defaultValue: "One Title" }],
    ]);
  });

  // A real i18n stub that honours defaultValue: the fallback must be what the
  // user sees when the key is unknown.
  it("renders the English fallback when the key is missing", () => {
    const t = (_key: string, vars?: Record<string, unknown>): string =>
      String(vars?.defaultValue ?? _key);
    expect(settingsSectionLabel(section(), t)).toBe("One");
    expect(settingsSectionTitle(section(), t)).toBe("One Title");
  });
});
