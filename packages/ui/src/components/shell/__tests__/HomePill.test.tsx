/** Verifies HomePill through the package's configured test harness. */
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
  it("renders an accessible button with only a compact white visual handle", () => {
    render(<HomePill phase="idle" onOpen={() => {}} onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: /open eliza/i });
    expect(btn).toBeTruthy();
    const mark = screen.getByTestId("shell-home-pill-mark");
    expect(mark.className).toContain("bg-white/95");
    expect(mark.className).toContain("w-12");
    expect(mark.className).toContain("shadow-[0_0_0_1px_rgba(0,0,0,0.12)]");
    expect(mark.className).not.toContain("0_1px_7px");
    expect(btn.textContent).toBe("");
    expect(btn.style.backgroundColor).toBe("");
    expect(btn.className).toContain("h-8");
  });

  it("calls onOpen when clicked from idle", () => {
    const onOpen = vi.fn();
    render(<HomePill phase="idle" onOpen={onOpen} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicked from summoned", () => {
    const onClose = vi.fn();
    render(<HomePill phase="summoned" onOpen={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button").textContent).toBe("");
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

  it("stays available while booting", () => {
    render(<HomePill phase="booting" onOpen={() => {}} onClose={() => {}} />);
    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.getByTestId("shell-home-pill-mark").className).toContain(
      "animate-pulse",
    );
  });

  it("opens the popup when clicked during booting", () => {
    const onOpen = vi.fn();
    render(<HomePill phase="booting" onOpen={onOpen} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
