// @vitest-environment jsdom

/**
 * Integration test for the settings section-nav (#13590): the folded top-bar
 * strip that replaced the desktop `w-60` rail. It renders REAL sections through
 * the SHARED `SectionNavTab` primitive (from `../shared/SectionNav`), so this
 * doubles as the "SectionNav-integration test for the settings group" — it
 * confirms Settings drives the same ghost-tab primitive the app-shell families
 * use, grouped by Agent / System / Security, with active-tab marking + select.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Settings } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSectionNav } from "./SettingsSectionNav";
import type { GroupedSettingsSections } from "./settings-sections";

/** A minimal section def shaped like the registry's, enough for the nav. */
function section(id: string, label: string, group: string) {
  return {
    id,
    label: `settings.sections.${id}.label`,
    defaultLabel: label,
    icon: Settings,
    tone: "neutral" as const,
    hue: "slate" as const,
    group,
    titleKey: `settings.sections.${id}.label`,
    defaultTitle: label,
    Component: () => null,
  };
}

const grouped: GroupedSettingsSections = [
  {
    group: "agent",
    label: "Agent",
    items: [
      section("identity", "Basics", "agent"),
      section("ai-model", "Models & Providers", "agent"),
    ],
  },
  {
    group: "system",
    label: "System",
    items: [section("runtime", "Runtime", "system")],
  },
  {
    group: "security",
    label: "Security",
    items: [
      section("secrets", "Vault", "security"),
      section("security", "Security", "security"),
    ],
  },
] as unknown as GroupedSettingsSections;

/** Resolve labels straight to their fallback (no i18n table in the test). */
const label = (_key: string, fallback: string) => fallback;

afterEach(() => cleanup());

describe("SettingsSectionNav", () => {
  it("renders one ghost tab per section, clustered under each group label", () => {
    render(
      <SettingsSectionNav
        grouped={grouped}
        activeId={null}
        onSelect={vi.fn()}
        label={label}
      />,
    );
    const nav = screen.getByTestId("settings-section-nav");
    // Group labels are present as cluster headers.
    expect(nav.textContent).toContain("Agent");
    expect(nav.textContent).toContain("System");
    expect(nav.textContent).toContain("Security");
    // One tab (button) per section, in group + declared order.
    const tabLabels = Array.from(nav.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    expect(tabLabels).toEqual([
      "Basics",
      "Models & Providers",
      "Runtime",
      "Vault",
      "Security",
    ]);
  });

  it("marks only the active section's tab with aria-current=page", () => {
    render(
      <SettingsSectionNav
        grouped={grouped}
        activeId="runtime"
        onSelect={vi.fn()}
        label={label}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "Runtime" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("button", { name: "Basics" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("calls onSelect with the section id when an inactive tab is clicked", () => {
    const onSelect = vi.fn();
    render(
      <SettingsSectionNav
        grouped={grouped}
        activeId="runtime"
        onSelect={onSelect}
        label={label}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Vault" }));
    expect(onSelect).toHaveBeenCalledWith("secrets");
  });

  it("does not re-select the already-active tab (shared primitive guard)", () => {
    const onSelect = vi.fn();
    render(
      <SettingsSectionNav
        grouped={grouped}
        activeId="runtime"
        onSelect={onSelect}
        label={label}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps a single-section group's lone tab (unlike the app-shell strip)", () => {
    // The System group has exactly one section here; Settings still shows it
    // (the whole view is the section family), whereas SectionTabStrip hides a
    // single-member app-shell section. Assert the lone System tab renders.
    render(
      <SettingsSectionNav
        grouped={grouped}
        activeId={null}
        onSelect={vi.fn()}
        label={label}
      />,
    );
    expect(screen.getByRole("button", { name: "Runtime" })).toBeTruthy();
  });
});
