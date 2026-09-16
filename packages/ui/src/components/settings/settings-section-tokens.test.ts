/**
 * Settings-section token resolution. The token map must be DERIVED from the
 * section registry (META + declared aliases), not a hand-maintained literal that
 * silently misses plugin-registered sections. These tests pin:
 *   - every built-in section id + declared alias resolves,
 *   - a plugin/host section registered at boot is reachable by its id AND its
 *     declared aliases (the drift/failure mode that made the central literal
 *     unsafe: dynamic sections were previously unreachable), and
 *   - the legacy fallback map still resolves (covered legacy path).
 */

import { Cog } from "lucide-react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetUiRegistryHostForTests } from "../../registry-host";
import { SETTINGS_SECTION_META } from "./settings-section-meta";
import {
  registerSettingsSection,
  type SettingsSectionDef,
} from "./settings-section-registry";
import {
  LEGACY_SETTINGS_SECTION_TOKEN_ALIASES,
  resolveSettingsSectionToken,
  SETTINGS_SECTION_SUGGESTIONS,
  SETTINGS_SECTION_TOKEN_ALIASES,
} from "./settings-section-tokens";

function makeSection(
  id: string,
  overrides: Partial<SettingsSectionDef> = {},
): SettingsSectionDef {
  return {
    id,
    label: `settings.sections.${id}.label`,
    defaultLabel: id,
    icon: Cog,
    tone: "neutral",
    hue: "slate",
    group: "system",
    titleKey: `settings.sections.${id}.label`,
    defaultTitle: id,
    Component: () => null,
    ...overrides,
  };
}

describe("SETTINGS_SECTION_TOKEN_ALIASES (derived from META)", () => {
  it("maps every built-in section id and declared alias to its canonical id", () => {
    for (const meta of SETTINGS_SECTION_META) {
      // The id is always a token for itself.
      expect(SETTINGS_SECTION_TOKEN_ALIASES[meta.id]).toBe(meta.id);
      // Every declared alias resolves to the same canonical id.
      for (const alias of meta.aliases ?? []) {
        expect(SETTINGS_SECTION_TOKEN_ALIASES[alias.toLowerCase()]).toBe(
          meta.id,
        );
      }
    }
  });

  it("exposes each built-in id and alias as a completion suggestion", () => {
    const suggestions = new Set(SETTINGS_SECTION_SUGGESTIONS);
    for (const meta of SETTINGS_SECTION_META) {
      expect(suggestions.has(meta.id)).toBe(true);
      for (const alias of meta.aliases ?? []) {
        expect(suggestions.has(alias.toLowerCase())).toBe(true);
      }
    }
  });
});

describe("resolveSettingsSectionToken", () => {
  beforeEach(() => {
    resetUiRegistryHostForTests();
  });

  it("resolves built-in ids and aliases derived from META", () => {
    expect(resolveSettingsSectionToken("identity")).toBe("identity");
    expect(resolveSettingsSectionToken("basics")).toBe("identity");
    expect(resolveSettingsSectionToken("profile")).toBe("identity");
    expect(resolveSettingsSectionToken("general")).toBe("appearance");
    expect(resolveSettingsSectionToken("model")).toBe("ai-model");
    expect(resolveSettingsSectionToken("providers")).toBe("ai-model");
    expect(resolveSettingsSectionToken("vault")).toBe("secrets");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(resolveSettingsSectionToken("  Model ")).toBe("ai-model");
    expect(resolveSettingsSectionToken("SECRETS")).toBe("secrets");
  });

  it("returns undefined for empty or unknown tokens", () => {
    expect(resolveSettingsSectionToken("")).toBeUndefined();
    expect(resolveSettingsSectionToken("   ")).toBeUndefined();
    expect(resolveSettingsSectionToken("not-a-section")).toBeUndefined();
  });

  it("reaches a plugin-registered section by its id (the previously-missed case)", () => {
    // Before deriving from the registry, a section registered at boot was
    // unreachable via `/settings <id>` because the token map was a static
    // literal. Registering it must make its id resolvable.
    expect(resolveSettingsSectionToken("plugin-analytics")).toBeUndefined();
    registerSettingsSection(makeSection("plugin-analytics"));
    expect(resolveSettingsSectionToken("plugin-analytics")).toBe(
      "plugin-analytics",
    );
  });

  it("reaches a plugin-registered section by its OWNER-DECLARED aliases", () => {
    registerSettingsSection(
      makeSection("plugin-billing", { aliases: ["invoices", "Payments"] }),
    );
    expect(resolveSettingsSectionToken("invoices")).toBe("plugin-billing");
    // Aliases are matched case-insensitively.
    expect(resolveSettingsSectionToken("payments")).toBe("plugin-billing");
    expect(resolveSettingsSectionToken("plugin-billing")).toBe(
      "plugin-billing",
    );
  });

  it("prefers a built-in over a registry entry that shadows its id", () => {
    // A built-in id must keep resolving even if a plugin re-registers the id;
    // token resolution short-circuits on the built-in map first.
    registerSettingsSection(makeSection("secrets", { aliases: ["hijack"] }));
    expect(resolveSettingsSectionToken("secrets")).toBe("secrets");
  });
});

describe("legacy fallback coverage (drift guard)", () => {
  beforeEach(() => {
    resetUiRegistryHostForTests();
  });

  it("still resolves every legacy hand-maintained token to the same id", () => {
    // The legacy literal is retained only as a covered fallback: every entry
    // must resolve to the SAME canonical id the derived map produces, so a
    // future divergence between the two is caught here rather than shipping a
    // token that silently points at the wrong (or a stale) section.
    for (const [token, expectedId] of Object.entries(
      LEGACY_SETTINGS_SECTION_TOKEN_ALIASES,
    )) {
      expect(resolveSettingsSectionToken(token)).toBe(expectedId);
    }
  });

  it("has migrated every legacy token into the derived META map", () => {
    // Guards against the derived map silently losing a built-in token: each
    // legacy token must now be produced by the META derivation (id or alias),
    // proving the hand-map is pure redundancy and safe to treat as fallback.
    for (const token of Object.keys(LEGACY_SETTINGS_SECTION_TOKEN_ALIASES)) {
      expect(SETTINGS_SECTION_TOKEN_ALIASES[token]).toBe(
        LEGACY_SETTINGS_SECTION_TOKEN_ALIASES[token],
      );
    }
  });
});
