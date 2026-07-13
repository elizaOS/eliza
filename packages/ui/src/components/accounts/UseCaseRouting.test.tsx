/**
 * Exercises the routing-chain editor's reorder, removal, and provider-add
 * interactions with the same accessible controls used by the settings UI.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(cleanup);

vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      t: (_key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? "",
    }),
}));

import { UseCaseRouting } from "./UseCaseRouting";

const providers = [
  { providerId: "openai-api", strategy: "priority", accounts: [] },
  { providerId: "anthropic-api", strategy: "priority", accounts: [] },
  { providerId: "cerebras-api", strategy: "priority", accounts: [] },
] as const;

describe("UseCaseRouting", () => {
  it("reorders and removes existing tiers", () => {
    const onChange = vi.fn();
    render(
      <UseCaseRouting
        useCase="chat"
        tiers={[
          { providerId: "openai-api", status: "available" },
          {
            providerId: "anthropic-api",
            status: "throttled",
            resetsAt: Date.now() + 60_000,
          },
        ]}
        eligibleProviders={["openai-api", "anthropic-api", "cerebras-api"]}
        providers={[...providers]}
        saving={false}
        onChange={onChange}
      />,
    );

    const moveEarlier = screen.getAllByRole("button", {
      name: "Move earlier in chain",
    });
    const secondMoveEarlier = moveEarlier[1];
    expect(secondMoveEarlier).toBeDefined();
    if (!secondMoveEarlier) throw new Error("Second routing tier is missing");
    fireEvent.click(secondMoveEarlier);
    expect(onChange).toHaveBeenCalledWith([
      { providerId: "anthropic-api" },
      { providerId: "openai-api" },
    ]);

    const firstRemove = screen.getAllByRole("button", {
      name: "Remove from chain",
    })[0];
    expect(firstRemove).toBeDefined();
    if (!firstRemove) throw new Error("First routing tier is missing");
    fireEvent.click(firstRemove);
    expect(onChange).toHaveBeenCalledWith([{ providerId: "anthropic-api" }]);
  });

  it("adds an unused eligible provider and renders the designed empty state", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <UseCaseRouting
        useCase="codingAgent"
        tiers={[]}
        eligibleProviders={["cerebras-api"]}
        providers={[...providers]}
        saving={false}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/No explicit chain/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Add fallback provider" }),
    );
    fireEvent.pointerDown(screen.getByRole("combobox"), {
      button: 0,
      ctrlKey: false,
      pointerId: 3,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("option", { name: "Cerebras API" }));
    expect(onChange).toHaveBeenCalledWith([{ providerId: "cerebras-api" }]);

    rerender(
      <UseCaseRouting
        useCase="codingAgent"
        tiers={[{ providerId: "cerebras-api", status: "unavailable" }]}
        eligibleProviders={["cerebras-api"]}
        providers={[...providers]}
        saving={false}
        onChange={onChange}
      />,
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "All eligible providers added",
      }).disabled,
    ).toBe(true);
  });
});
