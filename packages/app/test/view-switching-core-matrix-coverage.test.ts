/**
 * Unit tests for the View Switching Core Matrix Coverage app shell contract
 * and coverage guardrail.
 */
import { describe, expect, it } from "vitest";
import { SETTINGS_SECTION_META } from "../../ui/src/components/settings/settings-section-meta";
import {
  CORE_VIEW_SWITCH_PAIRS,
  CORE_VIEW_SWITCH_TARGETS,
  REQUIRED_CORE_VIEW_IDS,
  REQUIRED_SETTINGS_SECTION_IDS,
  SETTINGS_SECTION_SWITCH_PAIRS,
  SETTINGS_SECTION_SWITCH_TARGETS,
} from "./ui-smoke/view-switching-core-matrix";

describe("core view-switching matrix coverage", () => {
  it("tracks every named core view from the coverage objective", () => {
    expect(CORE_VIEW_SWITCH_TARGETS.map((target) => target.id)).toEqual(
      REQUIRED_CORE_VIEW_IDS,
    );
    expect(
      new Set(CORE_VIEW_SWITCH_TARGETS.map((target) => target.path)).size,
    ).toBe(CORE_VIEW_SWITCH_TARGETS.length);
  });

  it("tracks every canonical built-in settings subsection", () => {
    const canonicalSettingsIds = SETTINGS_SECTION_META.map(
      (section) => section.id,
    );
    expect(REQUIRED_SETTINGS_SECTION_IDS).toEqual(canonicalSettingsIds);
    expect(
      SETTINGS_SECTION_SWITCH_TARGETS.map((target) =>
        target.id.replace(/^settings\./, ""),
      ),
    ).toEqual(canonicalSettingsIds);
  });

  it("contains every ordered core-view source to target pair", () => {
    const expectedCount =
      CORE_VIEW_SWITCH_TARGETS.length * (CORE_VIEW_SWITCH_TARGETS.length - 1);
    expect(CORE_VIEW_SWITCH_PAIRS).toHaveLength(expectedCount);

    const pairKeys = new Set(
      CORE_VIEW_SWITCH_PAIRS.map(
        ({ source, target }) => `${source.id}->${target.id}`,
      ),
    );
    for (const source of CORE_VIEW_SWITCH_TARGETS) {
      for (const target of CORE_VIEW_SWITCH_TARGETS) {
        if (source.id === target.id) continue;
        expect(pairKeys.has(`${source.id}->${target.id}`)).toBe(true);
      }
    }
  });

  it("contains every ordered settings-subsection source to target pair", () => {
    const expectedCount =
      SETTINGS_SECTION_SWITCH_TARGETS.length *
      (SETTINGS_SECTION_SWITCH_TARGETS.length - 1);
    expect(SETTINGS_SECTION_SWITCH_PAIRS).toHaveLength(expectedCount);

    const pairKeys = new Set(
      SETTINGS_SECTION_SWITCH_PAIRS.map(
        ({ source, target }) => `${source.id}->${target.id}`,
      ),
    );
    for (const source of SETTINGS_SECTION_SWITCH_TARGETS) {
      for (const target of SETTINGS_SECTION_SWITCH_TARGETS) {
        if (source.id === target.id) continue;
        expect(pairKeys.has(`${source.id}->${target.id}`)).toBe(true);
      }
    }
  });
});
