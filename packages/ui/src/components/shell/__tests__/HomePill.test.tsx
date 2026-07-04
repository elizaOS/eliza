// @vitest-environment jsdom
//
// HomePill rendering + phase→interaction wiring (label, mark, open/close on
// click). Deterministic jsdom render via testing-library — no runtime, no model.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HomePill } from "../HomePill";
import type { ShellPhase } from "../shell-state";

afterEach(() => cleanup());

describe("HomePill", () => {
  it("renders a button labelled for the assistant", () => {
    render(<HomePill phase="idle" onOpen={() => {}} onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: /open eliza/i });
    expect(btn).toBeTruthy();
    expect(screen.getByTestId("shell-home-pill-mark")).toBeTruthy();
  });

  it("calls onOpen when clicked from idle", () => {
    const onOpen = vi.fn();
    render(<HomePill phase="idle" onOpen={onOpen} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("lets the overlay shell own native-window positioning", () => {
    render(<HomePill phase="idle" onOpen={() => {}} onClose={() => {}} />);
    const className = screen.getByRole("button").className;

    expect(className).toContain("relative");
    expect(className).toContain("mb-3");
    expect(className).not.toContain("fixed");
    expect(className).not.toContain("left-1/2");
    expect(className).not.toContain("-translate-x-1/2");
  });

  it("calls onClose when clicked from summoned", () => {
    const onClose = vi.fn();
    render(<HomePill phase="summoned" onOpen={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each<ShellPhase>([
    "booting",
    "idle",
    "summoned",
    "listening",
    "responding",
  ])("renders a data-phase attribute for phase=%s", (phase) => {
    render(<HomePill phase={phase} onOpen={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button").getAttribute("data-phase")).toBe(phase);
  });

  it("is aria-pressed=true when summoned/listening/responding, false when idle/booting", () => {
    const { rerender } = render(
      <HomePill phase="idle" onOpen={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "false",
    );
    rerender(<HomePill phase="booting" onOpen={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "false",
    );
    rerender(
      <HomePill phase="summoned" onOpen={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "true",
    );
    rerender(
      <HomePill phase="listening" onOpen={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "true",
    );
    rerender(
      <HomePill phase="responding" onOpen={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("is disabled while booting", () => {
    render(<HomePill phase="booting" onOpen={() => {}} onClose={() => {}} />);
    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("does not call onOpen when clicked during booting", () => {
    const onOpen = vi.fn();
    render(<HomePill phase="booting" onOpen={onOpen} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
