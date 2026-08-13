/** Verifies SettingsRow through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Renders the settings-layout primitives (SettingsRow/Group/Stack) and the
 * agent-addressable rows (SettingsSelectRow/SettingsSwitchRow) to assert label
 * + inline-control structure and agent-surface wiring. jsdom, no backend.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Bell } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SettingsInputRow,
  SettingsSelectRow,
  SettingsSwitchRow,
} from "./settings-agent-rows";
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
    expect(sw.getAttribute("data-agent-label")).toBe("Dark mode");
    expect(sw.getAttribute("id")).toBe("toggle-dark");
    expect(screen.getByText("Dark mode").tagName).toBe("LABEL");
    expect(screen.getByText("Dark mode").getAttribute("for")).toBe(
      "toggle-dark",
    );
    fireEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("SettingsSwitchRow stays disabled when the agent status is unavailable", () => {
    render(
      <SettingsSwitchRow
        agentId="notifications-push-toggle"
        label="Push notifications"
        agentLabel="Toggle push notifications"
        checked={false}
        agentStatus="unavailable"
        disabled
        onCheckedChange={() => {}}
      />,
    );
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("data-agent-id")).toBe("notifications-push-toggle");
    expect(sw.getAttribute("data-agent-label")).toBe(
      "Toggle push notifications",
    );
    expect(sw).toHaveProperty("disabled", true);
  });

  it("SettingsInputRow labels the field and exposes agent data attributes", () => {
    const onValueChange = vi.fn();
    render(
      <SettingsInputRow
        agentId="security-password-new"
        label="New password"
        type="password"
        value=""
        onValueChange={onValueChange}
        testId="security-password-new-input"
      />,
    );
    const input = screen.getByLabelText("New password");
    expect(input.getAttribute("data-agent-id")).toBe("security-password-new");
    expect(input.getAttribute("data-agent-role")).toBe("text-input");
    expect(input.getAttribute("id")).toBe("security-password-new");
    expect(input.getAttribute("data-testid")).toBe(
      "security-password-new-input",
    );
    expect(input.getAttribute("aria-label")).toBeNull();
    expect(screen.getByText("New password").tagName).toBe("LABEL");
    expect(screen.getByText("New password").getAttribute("for")).toBe(
      "security-password-new",
    );
    fireEvent.change(input, { target: { value: "abcdefghijkl" } });
    expect(onValueChange).toHaveBeenCalledWith("abcdefghijkl");
  });

  it("SettingsInputRow announces a validation error below the field", () => {
    render(
      <SettingsInputRow
        agentId="security-password-confirm"
        label="Confirm new password"
        type="password"
        value="nope"
        onValueChange={() => {}}
        error="Passwords do not match."
      />,
    );
    const input = screen.getByLabelText("Confirm new password");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Passwords do not match.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(
      "security-password-confirm-error",
    );
    expect(alert.className).toContain("text-danger");
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
    expect(trigger.getAttribute("id")).toBe("pick-theme");
    expect(screen.getByText("Theme").tagName).toBe("LABEL");
  });

  it("SettingsSelectRow renders grouped options and a trailing control", () => {
    render(
      <SettingsSelectRow
        agentId="identity-voice"
        label="Voice"
        value="alloy"
        onValueChange={() => {}}
        groups={[
          {
            label: "Premade",
            items: [
              { value: "alloy", label: "Alloy", hint: "fast" },
              { value: "verse", label: "Verse" },
            ],
          },
        ]}
        trailing={<button type="button">Preview</button>}
        testId="identity-voice-trigger"
      />,
    );
    const trigger = screen.getByTestId("identity-voice-trigger");
    expect(trigger.getAttribute("data-agent-id")).toBe("identity-voice");
    expect(screen.getByText("Preview")).toBeTruthy();
  });
});
