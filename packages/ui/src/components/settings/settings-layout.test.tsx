// @vitest-environment jsdom
/**
 * Renders the settings-layout primitives (SettingsRow/Group/Stack) and the
 * agent-addressable rows (SettingsSelectRow/SettingsSwitchRow) to assert label
 * + inline-control structure and agent-surface wiring. jsdom, no backend.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Bell } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSelectRow, SettingsSwitchRow } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

afterEach(() => cleanup());

describe("SettingsRow", () => {
  it("renders label, description, and an inline control", () => {
    render(
      <SettingsRow
        icon={Bell}
        label="Notifications"
        description="Ping me on updates"
        control={<span data-testid="ctrl">on</span>}
      />,
    );
    expect(screen.getByText("Notifications")).toBeTruthy();
    expect(screen.getByText("Ping me on updates")).toBeTruthy();
    expect(screen.getByTestId("ctrl")).toBeTruthy();
  });

  it("becomes a button with a chevron when given onClick", () => {
    const onClick = vi.fn();
    render(<SettingsRow label="Open thing" onClick={onClick} />);
    const button = screen.getByText("Open thing").closest("button");
    expect(button).toBeTruthy();
    fireEvent.click(button as HTMLButtonElement);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders stacked children below the label", () => {
    render(
      <SettingsRow label="Endpoint" stacked>
        <input data-testid="wide" />
      </SettingsRow>,
    );
    expect(screen.getByTestId("wide")).toBeTruthy();
  });
});

describe("SettingsGroup", () => {
  it("renders a kicker title and its rows", () => {
    render(
      <SettingsStack>
        <SettingsGroup title="Agent" description="Core behavior">
          <SettingsRow label="Row A" />
          <SettingsRow label="Row B" />
        </SettingsGroup>
      </SettingsStack>,
    );
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("Core behavior")).toBeTruthy();
    expect(screen.getByText("Row A")).toBeTruthy();
    expect(screen.getByText("Row B")).toBeTruthy();
  });

  it("keeps its title, description, and footer at accessible contrast", () => {
    render(
      <SettingsStack>
        <SettingsGroup
          title="Agent"
          description="Core behavior"
          footer="Applies immediately"
        >
          <SettingsRow label="Row A" />
        </SettingsGroup>
      </SettingsStack>,
    );
    // The section title/description/footer render `text-muted` at full
    // strength: the previous `/70` + `/80` opacity dropped these below the
    // WCAG AA 4.5:1 floor (3.54 and 4.36) across every settings panel.
    for (const text of ["Agent", "Core behavior", "Applies immediately"]) {
      const el = screen.getByText(text);
      expect(el.className).toContain("text-muted");
      expect(el.className).not.toContain("text-muted/70");
      expect(el.className).not.toContain("text-muted/80");
    }
  });
});

describe("agent-addressable rows", () => {
  it("SettingsSwitchRow toggles and exposes agent data attributes", () => {
    const onCheckedChange = vi.fn();
    render(
      <SettingsSwitchRow
        agentId="toggle-dark"
        label="Dark mode"
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("data-agent-id")).toBe("toggle-dark");
    expect(sw.getAttribute("data-agent-role")).toBe("toggle");
    fireEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("SettingsSelectRow registers as an agent-addressable select", () => {
    render(
      <SettingsSelectRow
        agentId="pick-theme"
        label="Theme"
        value="dark"
        onValueChange={() => {}}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />,
    );
    const trigger = screen.getByLabelText("Theme");
    expect(trigger.getAttribute("data-agent-id")).toBe("pick-theme");
    expect(trigger.getAttribute("data-agent-role")).toBe("select");
  });
});
