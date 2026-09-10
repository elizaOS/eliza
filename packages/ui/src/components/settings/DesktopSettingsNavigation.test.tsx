/** Exercises desktop settings navigation behavior in the package's jsdom component harness. */
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopSettingsNavigation } from "./DesktopSettingsNavigation";

const grouped = [
  {
    group: "agent",
    label: "Agent",
    items: [
      {
        id: "identity",
        label: "identity.label",
        defaultLabel: "Basics",
        icon: Settings,
        hue: "slate" as const,
      },
      {
        id: "ai-model",
        label: "models.label",
        defaultLabel: "Models & Providers",
        icon: Settings,
        hue: "accent" as const,
      },
    ],
  },
  {
    group: "system",
    label: "System",
    items: [
      {
        id: "appearance",
        label: "appearance.label",
        defaultLabel: "Appearance",
        icon: Settings,
        hue: "rose" as const,
      },
    ],
  },
];

const resolveLabel = (_key: string, fallback: string) => fallback;

afterEach(() => document.body.replaceChildren());

describe("DesktopSettingsNavigation", () => {
  it("renders every group and item in a flat list and marks the active item", () => {
    render(
      <DesktopSettingsNavigation
        grouped={grouped as never}
        activeId="ai-model"
        onSelect={vi.fn()}
        onBack={vi.fn()}
        settingsLabel="Settings"
        label={resolveLabel}
      />,
    );

    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("System")).toBeTruthy();
    expect(screen.getByText("Basics")).toBeTruthy();
    expect(screen.getByText("Models & Providers")).toBeTruthy();
    expect(screen.getByText("Appearance")).toBeTruthy();
    expect(screen.getByTestId("desktop-settings-group-agent")).toBeTruthy();
    expect(screen.getByTestId("desktop-settings-group-system")).toBeTruthy();
    expect(
      screen.queryByTestId("desktop-settings-group-toggle-agent"),
    ).toBeNull();
    expect(
      screen.queryByTestId("desktop-settings-group-toggle-system"),
    ).toBeNull();
    expect(
      screen
        .getByTestId("desktop-settings-item-ai-model")
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByTestId("desktop-settings-item-identity")
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(screen.getByTestId("desktop-settings-check-ai-model")).toBeTruthy();
    expect(screen.queryByText("Preferences and privacy")).toBeNull();
  });

  it("renders and invokes the launcher back utility only when provided", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const { rerender } = render(
      <DesktopSettingsNavigation
        grouped={grouped as never}
        activeId="identity"
        onSelect={vi.fn()}
        onBack={onBack}
        settingsLabel="Settings"
        label={resolveLabel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Back to launcher" }));
    expect(onBack).toHaveBeenCalledOnce();

    rerender(
      <DesktopSettingsNavigation
        grouped={grouped as never}
        activeId="identity"
        onSelect={vi.fn()}
        settingsLabel="Settings"
        label={resolveLabel}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Back to launcher" }),
    ).toBeNull();
  });

  it("wraps arrow-key focus and preserves native Enter and Space activation", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DesktopSettingsNavigation
        grouped={grouped as never}
        activeId="identity"
        onSelect={onSelect}
        onBack={vi.fn()}
        settingsLabel="Settings"
        label={resolveLabel}
      />,
    );

    const identity = screen.getByTestId("desktop-settings-item-identity");
    const models = screen.getByTestId("desktop-settings-item-ai-model");
    const appearance = screen.getByTestId("desktop-settings-item-appearance");

    identity.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(models);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(appearance);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(identity);

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(appearance);

    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("appearance");

    onSelect.mockClear();
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledWith("appearance");
  });
});
