/**
 * Loader component coverage for rendered spinner text, message updates, and
 * interval cleanup using a minimal TUI requestRender boundary.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Loader } from "../src/components/loader.js";
import type { TUI } from "../src/tui.js";

/**
 * Minimal TUI boundary for Loader tests.
 *
 * Loader only calls requestRender, and Pick<TUI, "requestRender"> keeps the
 * test double aligned with the public TUI shape.
 */
type MockTUI = Pick<TUI, "requestRender"> & {
  requestRender: ReturnType<typeof mock>;
};

describe("Loader component", () => {
  const createMockTUI = (): MockTUI => ({
    requestRender: vi.fn(() => {}),
  });

  let loader: Loader;
  let mockTUI: MockTUI;

  beforeEach(() => {
    mockTUI = createMockTUI();
  });

  afterEach(() => {
    // Spinner intervals must not leak between tests.
    if (loader) {
      loader.stop();
    }
  });

  // Loader only reaches requestRender, so this partial TUI is a bounded test double.
  const asTUI = (m: MockTUI): TUI => m as unknown as TUI;

  describe("constructor", () => {
    test("creates Loader with default message", () => {
      loader = new Loader(
        asTUI(mockTUI),
        (s) => s,
        (s) => s,
      );
      const lines = loader.render(40);
      expect(lines.some((l) => l.includes("Loading..."))).toBe(true);
    });

    test("creates Loader with custom message", () => {
      loader = new Loader(
        asTUI(mockTUI),
        (s) => s,
        (s) => s,
        "Processing...",
      );
      const lines = loader.render(40);
      expect(lines.some((l) => l.includes("Processing..."))).toBe(true);
    });

    test("applies spinner color function", () => {
      loader = new Loader(
        asTUI(mockTUI),
        (s) => `[SPIN]${s}[/SPIN]`,
        (s) => s,
      );
      const lines = loader.render(40);
      expect(lines.some((l) => l.includes("[SPIN]"))).toBe(true);
    });

    test("applies message color function", () => {
      loader = new Loader(
        asTUI(mockTUI),
        (s) => s,
        (s) => `[MSG]${s}[/MSG]`,
      );
      const lines = loader.render(40);
      expect(lines.some((l) => l.includes("[MSG]Loading...[/MSG]"))).toBe(true);
    });
  });

  describe("render", () => {
    test("renders with empty first line", () => {
      loader = new Loader(
        asTUI(mockTUI),
        (s) => s,
        (s) => s,
      );
      const lines = loader.render(40);
      expect(lines[0]).toBe("");
      expect(lines.length).toBeGreaterThan(1);
    });
  });

  describe("setMessage", () => {
    test("updates message", () => {
      loader = new Loader(
        asTUI(mockTUI),
        (s) => s,
        (s) => s,
        "Initial",
      );
      loader.setMessage("Updated");
      const lines = loader.render(40);
      expect(lines.some((l) => l.includes("Updated"))).toBe(true);
      expect(lines.some((l) => l.includes("Initial"))).toBe(false);
    });

    test("triggers render request", () => {
      loader = new Loader(
        asTUI(mockTUI),
        (s) => s,
        (s) => s,
      );
      // Clear the constructor-triggered request before measuring setMessage.
      mockTUI.requestRender.mockClear();
      loader.setMessage("New message");
      expect(mockTUI.requestRender).toHaveBeenCalled();
    });
  });

  describe("start/stop", () => {
    test("stop prevents further animations", async () => {
      loader = new Loader(
        asTUI(mockTUI),
        (s) => s,
        (s) => s,
      );
      loader.stop();
      // Only render requests after stop matter for this assertion.
      mockTUI.requestRender.mockClear();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(mockTUI.requestRender).not.toHaveBeenCalled();
    });

    test("multiple stop calls are safe", () => {
      loader = new Loader(
        asTUI(mockTUI),
        (s) => s,
        (s) => s,
      );
      expect(() => {
        loader.stop();
        loader.stop();
      }).not.toThrow();
    });
  });
});
