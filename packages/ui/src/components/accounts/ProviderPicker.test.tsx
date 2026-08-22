/**
 * ProviderPicker — command-palette behavior: search filtering, arrow-key
 * navigation, and Enter-to-pick, all keyboard-driven.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
});

vi.mock("../../state/app-store", () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      t: (_key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? "",
    }),
}));

import { ProviderPicker } from "./ProviderPicker";

function renderPicker(onPick = vi.fn()) {
  render(<ProviderPicker onPick={onPick} />);
  return onPick;
}

const searchInput = () =>
  screen.getByPlaceholderText("Search providers") as HTMLInputElement;

describe("ProviderPicker", () => {
  it("filters options by search query", () => {
    renderPicker();
    fireEvent.change(searchInput(), { target: { value: "codex" } });
    // The option row is exposed as a listbox option; the provider name also
    // appears in the brand-mark <title>, so scope the query to option roles.
    expect(
      screen.getByRole("option", { name: /OpenAI Codex subscription/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Anthropic API/ })).toBeNull();
  });

  it("picks the highlighted option on Enter after arrow navigation", () => {
    const onPick = renderPicker();
    fireEvent.keyDown(searchInput(), { key: "ArrowDown" });
    fireEvent.keyDown(searchInput(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledOnce();
  });

  it("shows an empty message when nothing matches", () => {
    renderPicker();
    fireEvent.change(searchInput(), { target: { value: "zzzznomatch" } });
    expect(screen.getByText("No providers match your search.")).toBeTruthy();
  });

  it("picks via click", () => {
    const onPick = renderPicker();
    fireEvent.change(searchInput(), { target: { value: "Anthropic API" } });
    fireEvent.click(screen.getByRole("option", { name: /Anthropic API/ }));
    expect(onPick).toHaveBeenCalledWith("anthropic-api");
  });

  // Product policy disables focus rings globally (styles.css); the search input
  // and option rows must not carry Tailwind focus/ring utilities — guards the
  // no-focus-ring-gate at the component level.
  it("renders the search input and options free of focus/ring utilities", () => {
    renderPicker();
    fireEvent.change(searchInput(), { target: { value: "Anthropic API" } });
    const targets = [
      searchInput(),
      screen.getByRole("option", { name: /Anthropic API/ }),
    ];
    for (const el of targets) {
      const cls = el.getAttribute("class") ?? "";
      expect(cls).not.toMatch(/(?:^|\s)(?:focus|focus-visible|focus-within):/);
      expect(cls).not.toMatch(/(?:^|\s)!?ring-/);
    }
  });

  it("navigates upward with ArrowUp and wraps around the list", () => {
    const onPick = renderPicker();
    // ArrowUp from the top wraps to the last option instead of going negative.
    fireEvent.keyDown(searchInput(), { key: "ArrowUp" });
    fireEvent.keyDown(searchInput(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledOnce();
  });

  it("renders sentence-style capability copy with no interpunct separators", () => {
    renderPicker();
    expect(
      screen.getAllByText(
        "Model inference, using your API key; agent spawn unavailable",
      ).length,
    ).toBe(6);
    expect(screen.getByText("Coding agents, using browser login")).toBeTruthy();
    expect(
      screen.getByText("No model inference or coding-agent spawn support"),
    ).toBeTruthy();
    expect(
      screen.getAllByText(
        "Model inference, using a coding-plan key; agent spawn unavailable",
      ).length,
    ).toBe(2);
    // The old "Chat \u00b7 bring your own API key" pill format must not resurface.
    expect(screen.queryByText(/\u00b7/)).toBeNull();
  });
});
