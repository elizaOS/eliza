/** Verifies AgentsEmptyState (agent library, zero agents) through the package's configured test harness. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState as AgentsEmptyState } from "./empty-state";

const translate = vi.hoisted(
  () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
);

vi.mock("../lib/i18n", () => ({
  useT: () => translate,
}));

describe("AgentsEmptyState (agent library, zero agents)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("guides a brand-new user toward creating their first agent", () => {
    render(<AgentsEmptyState onCreateNew={() => {}} />);

    // Title reads as a plain, non-jargon state.
    expect(screen.getByText("No agents yet")).toBeTruthy();
    // A supporting description tells them what to do next.
    expect(
      screen.getByText(
        "Create your first agent to start chatting. It only takes a minute.",
      ),
    ).toBeTruthy();
    // The CTA names the actual outcome, not "Open runtime admin".
    expect(
      screen.getByRole("button", { name: /create your first agent/i }),
    ).toBeTruthy();
  });

  it("fires onCreateNew when the CTA is clicked", async () => {
    const onCreateNew = vi.fn();
    render(<AgentsEmptyState onCreateNew={onCreateNew} />);

    await userEvent.click(
      screen.getByRole("button", { name: /create your first agent/i }),
    );

    expect(onCreateNew).toHaveBeenCalledTimes(1);
  });
});
