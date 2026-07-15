// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
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
  it("renders grouped sections and marks the active item", () => {
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
    expect(screen.getByText("Models & Providers")).toBeTruthy();
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
  });

  it("moves focus with arrow keys across groups and activates with Enter", () => {
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
    fireEvent.keyDown(identity, { key: "ArrowDown" });
    expect(document.activeElement).toBe(models);

    fireEvent.keyDown(models, { key: "ArrowDown" });
    expect(document.activeElement).toBe(appearance);

    fireEvent.keyDown(appearance, { key: "ArrowDown" });
    expect(document.activeElement).toBe(identity);

    fireEvent.keyDown(identity, { key: "ArrowUp" });
    expect(document.activeElement).toBe(appearance);

    fireEvent.keyDown(appearance, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("appearance");
  });
});
