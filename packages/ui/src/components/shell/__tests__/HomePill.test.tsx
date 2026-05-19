// @vitest-environment jsdom

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
