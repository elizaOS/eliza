// @vitest-environment jsdom
/**
 * Renders AutoSendToggle in jsdom and asserts the in-flow mic-surface switch:
 * on/off icon + aria state, click-to-flip onChange, and disabled suppression.
 * RTL, no live model. (The persistence + send-behavior are covered separately in
 * persistence-voice-auto-send.test.ts + auto-send-guard.test.ts.)
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AutoSendToggle } from "./AutoSendToggle";

afterEach(() => {
  cleanup();
});

describe("AutoSendToggle", () => {
  it("renders OFF (review) state by default value", () => {
    render(<AutoSendToggle value={false} onChange={() => {}} />);
    const btn = screen.getByTestId("chat-composer-auto-send-toggle");
    expect(btn.getAttribute("data-auto-send")).toBe("off");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("renders ON (auto-send) state when value is true", () => {
    render(<AutoSendToggle value onChange={() => {}} />);
    const btn = screen.getByTestId("chat-composer-auto-send-toggle");
    expect(btn.getAttribute("data-auto-send")).toBe("on");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("flips OFF → ON on click", () => {
    const onChange = vi.fn();
    render(<AutoSendToggle value={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("chat-composer-auto-send-toggle"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("flips ON → OFF on click", () => {
    const onChange = vi.fn();
    render(<AutoSendToggle value onChange={onChange} />);
    fireEvent.click(screen.getByTestId("chat-composer-auto-send-toggle"));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("ignores clicks while disabled", () => {
    const onChange = vi.fn();
    render(<AutoSendToggle value={false} onChange={onChange} disabled />);
    fireEvent.click(screen.getByTestId("chat-composer-auto-send-toggle"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
