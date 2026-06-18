// @vitest-environment jsdom

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
