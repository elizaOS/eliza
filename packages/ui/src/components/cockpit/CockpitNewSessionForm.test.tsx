// @vitest-environment jsdom
//
// Interaction tests for CockpitNewSessionForm: submit stays disabled until a
// goal is entered, and submitting hands the parent a lowered create-task input.
// Deterministic RTL/jsdom, no network.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CockpitNewSessionForm } from "./CockpitNewSessionForm";

afterEach(cleanup);

describe("CockpitNewSessionForm", () => {
  it("disables submit until a goal is entered", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CockpitNewSessionForm onCreate={onCreate} />);
    const button = screen.getByTestId(
      "cockpit-start-button",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(screen.getByTestId("cockpit-goal-input"), "fix the bug");
    expect(button.disabled).toBe(false);
  });

  it("submits a create-task input with the default (Eliza Cloud · Fast) policy", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CockpitNewSessionForm onCreate={onCreate} />);
    await user.type(screen.getByTestId("cockpit-goal-input"), "fix the bug");
    await user.click(screen.getByTestId("cockpit-start-button"));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      title: "fix the bug",
      goal: "fix the bug",
      providerPolicy: {
        preferredFramework: "elizaos",
        providerSource: "eliza-cloud",
        model: "gemma-4-31b",
      },
    });
  });

  it("reflects a mode switch in the submitted policy", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CockpitNewSessionForm onCreate={onCreate} />);
    await user.type(screen.getByTestId("cockpit-goal-input"), "do it");
    await user.click(screen.getByTestId("cockpit-mode-claude"));
    await user.click(screen.getByTestId("cockpit-start-button"));
    expect(onCreate).toHaveBeenLastCalledWith({
      title: "do it",
      goal: "do it",
      providerPolicy: {
        preferredFramework: "claude",
        providerSource: "user-claude",
      },
    });
  });

  it("does not submit while busy", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CockpitNewSessionForm onCreate={onCreate} busy />);
    await user.click(screen.getByTestId("cockpit-start-button"));
    expect(onCreate).not.toHaveBeenCalled();
  });
});
