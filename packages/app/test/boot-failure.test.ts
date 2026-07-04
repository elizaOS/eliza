// @vitest-environment jsdom
//
// Boot resilience: main() awaits fallible pre-mount chunks; if one rejects the
// app used to be a permanent blank page. renderBootFailure is the .catch that
// guarantees an actionable reload card instead. (#<boot-white-screen>)

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderBootFailure } from "../src/boot-failure";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("renderBootFailure", () => {
  it("paints a reload card into #root instead of leaving a blank page", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = '<div id="root"></div>';

    renderBootFailure(new Error("chunk 404"));

    const card = document.querySelector('[data-testid="boot-failure"]');
    expect(card).toBeTruthy();
    const button = card?.querySelector("button");
    expect(button?.textContent).toBe("Reload");
  });

  it("clears any partial content in #root before painting", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = '<div id="root"><span>half-mounted</span></div>';

    renderBootFailure(new Error("boom"));

    const root = document.getElementById("root");
    expect(root?.textContent).not.toContain("half-mounted");
    expect(root?.querySelector('[data-testid="boot-failure"]')).toBeTruthy();
  });

  it("is a no-op (no throw) when #root is absent", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderBootFailure(new Error("x"))).not.toThrow();
  });

  it("the Reload button triggers a full page reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    // jsdom's location.reload is non-configurable; stub via the getter path.
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, reload },
    });
    document.body.innerHTML = '<div id="root"></div>';

    renderBootFailure(new Error("x"));
    document
      .querySelector<HTMLButtonElement>('[data-testid="boot-failure"] button')
      ?.click();

    expect(reload).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    });
  });
});
