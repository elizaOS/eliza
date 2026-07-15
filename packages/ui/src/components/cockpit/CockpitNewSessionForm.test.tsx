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

  it("submits a create-task input with the default (Eliza Cloud · Fast) policy and no target when the repo is blank", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CockpitNewSessionForm onCreate={onCreate} />);
    await user.type(screen.getByTestId("cockpit-goal-input"), "fix the bug");
    await user.click(screen.getByTestId("cockpit-start-button"));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(
      {
        title: "fix the bug",
        goal: "fix the bug",
        providerPolicy: {
          preferredFramework: "elizaos",
          providerSource: "eliza-cloud",
          model: "gemma-4-31b",
        },
      },
      undefined,
    );
  });

  it("threads the repo (and workdir) into the spawn target", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CockpitNewSessionForm onCreate={onCreate} />);
    await user.type(screen.getByTestId("cockpit-goal-input"), "fix the bug");
    await user.type(screen.getByTestId("cockpit-repo-input"), "elizaOS/eliza");
    await user.type(screen.getByTestId("cockpit-workdir-input"), "packages/ui");
    await user.click(screen.getByTestId("cockpit-start-button"));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenLastCalledWith(expect.any(Object), {
      repo: "elizaOS/eliza",
      workdir: "packages/ui",
    });
  });

  it("trims a repo and omits an empty workdir from the target", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CockpitNewSessionForm onCreate={onCreate} />);
    await user.type(screen.getByTestId("cockpit-goal-input"), "go");
    await user.type(
      screen.getByTestId("cockpit-repo-input"),
      "  elizaOS/eliza  ",
    );
    await user.click(screen.getByTestId("cockpit-start-button"));
    expect(onCreate).toHaveBeenLastCalledWith(expect.any(Object), {
      repo: "elizaOS/eliza",
    });
  });

  it("blocks submit when a workdir is set without a repo, then clears once a repo is added", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CockpitNewSessionForm onCreate={onCreate} />);
    await user.type(screen.getByTestId("cockpit-goal-input"), "go");
    await user.type(screen.getByTestId("cockpit-workdir-input"), "packages/ui");
    const button = screen.getByTestId(
      "cockpit-start-button",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("cockpit-workdir-error")).toBeTruthy();
    await user.type(screen.getByTestId("cockpit-repo-input"), "elizaOS/eliza");
    expect(button.disabled).toBe(false);
    await user.click(button);
    expect(onCreate).toHaveBeenLastCalledWith(expect.any(Object), {
      repo: "elizaOS/eliza",
      workdir: "packages/ui",
    });
  });

  it("renders a repo suggestion datalist only when knownRepos are provided", async () => {
    const { rerender } = render(<CockpitNewSessionForm onCreate={vi.fn()} />);
    expect(screen.queryByTestId("cockpit-repo-suggestions")).toBeNull();
    rerender(
      <CockpitNewSessionForm
        onCreate={vi.fn()}
        knownRepos={["https://github.com/elizaOS/eliza.git"]}
      />,
    );
    const list = screen.getByTestId("cockpit-repo-suggestions");
    expect(list.querySelectorAll("option").length).toBe(1);
  });

  it("distinguishes unavailable repo suggestions from an empty registry", () => {
    render(
      <CockpitNewSessionForm onCreate={vi.fn()} repoSuggestionsUnavailable />,
    );
    expect(screen.getByText(/repo suggestions are unavailable/i)).toBeTruthy();
    expect(screen.getByTestId("cockpit-repo-input")).toBeTruthy();
  });

  it("keeps optional labels and repo guidance at accessible contrast", () => {
    render(<CockpitNewSessionForm onCreate={vi.fn()} />);

    for (const optionalLabel of screen.getAllByText("(optional)")) {
      expect(optionalLabel.className).toContain("text-muted");
      expect(optionalLabel.className).not.toContain("text-muted/70");
    }
    const guidance = screen.getByText(
      "Leave blank to run in a scratch workspace.",
    );
    expect(guidance.className).toContain("text-muted");
    expect(guidance.className).not.toContain("text-muted/70");
  });

  it("reflects a mode switch in the submitted policy", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CockpitNewSessionForm onCreate={onCreate} />);
    await user.type(screen.getByTestId("cockpit-goal-input"), "do it");
    await user.click(screen.getByTestId("cockpit-mode-claude"));
    await user.click(screen.getByTestId("cockpit-start-button"));
    expect(onCreate).toHaveBeenLastCalledWith(
      {
        title: "do it",
        goal: "do it",
        providerPolicy: {
          preferredFramework: "claude",
          providerSource: "user-claude",
        },
      },
      undefined,
    );
  });

  it("does not submit while busy", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CockpitNewSessionForm onCreate={onCreate} busy />);
    await user.click(screen.getByTestId("cockpit-start-button"));
    expect(onCreate).not.toHaveBeenCalled();
  });
});
