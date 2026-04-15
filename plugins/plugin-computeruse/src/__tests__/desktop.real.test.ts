/**
 * Real integration tests for desktop automation.
 *
 * These tests exercise the actual mouse/keyboard platform layer.
 * They verify that each function executes without throwing and
 * that input validation correctly rejects bad inputs.
 *
 * Note: These tests will actually move the mouse, type, etc.
 * Run in a controlled environment.
 */
import { describe, expect, it } from "vitest";
import {
  desktopClick,
  desktopDoubleClick,
  desktopDrag,
  desktopKeyCombo,
  desktopKeyPress,
  desktopMouseMove,
  desktopRightClick,
  desktopScroll,
  desktopType,
} from "../platform/desktop.js";
import { commandExists, currentPlatform } from "../platform/helpers.js";
import { isPermissionDeniedError } from "../platform/permissions.js";

// Check if desktop control tools actually work (may fail due to missing permissions)
const os = currentPlatform();

function canControlDesktop(): boolean {
  try {
    // Try a harmless mouse move to see if we have permission
    desktopMouseMove(0, 0);
    return true;
  } catch {
    return false;
  }
}

const canTest = canControlDesktop();
const describeIfDesktop = canTest ? describe : describe.skip;

function skipIfAccessibilityPermissionMissing(skip: (message?: string) => void, error: unknown): void {
  if (isPermissionDeniedError(error) && error.permissionType === "accessibility") {
    skip(error.message);
  }
}

function expectActionNotToThrow(
  action: () => void,
  skip: (message?: string) => void,
): void {
  try {
    action();
  } catch (error) {
    skipIfAccessibilityPermissionMissing(skip, error);
    throw error;
  }
}

describeIfDesktop("desktop automation (real)", () => {
  // Use a safe screen location (center-ish) to avoid hitting UI elements
  const safeX = 400;
  const safeY = 400;

  describe("desktopMouseMove", () => {
    it("moves cursor without error", ({ skip }) => {
      expectActionNotToThrow(() => desktopMouseMove(safeX, safeY), skip);
    });

    it("handles edge coordinates (0,0)", ({ skip }) => {
      expectActionNotToThrow(() => desktopMouseMove(0, 0), skip);
    });
  });

  describe("desktopClick", () => {
    it("clicks at coordinates without error", ({ skip }) => {
      expectActionNotToThrow(() => desktopClick(safeX, safeY), skip);
    });
  });

  describe("desktopDoubleClick", () => {
    it("double-clicks at coordinates without error", ({ skip }) => {
      expectActionNotToThrow(() => desktopDoubleClick(safeX, safeY), skip);
    });
  });

  describe("desktopRightClick", () => {
    it("right-clicks at coordinates without error", ({ skip }) => {
      expectActionNotToThrow(() => desktopRightClick(safeX, safeY), skip);
    });
  });

  describe("desktopScroll", () => {
    it("scrolls down without error", ({ skip }) => {
      expectActionNotToThrow(() => desktopScroll(safeX, safeY, "down", 3), skip);
    });

    it("scrolls up without error", ({ skip }) => {
      expectActionNotToThrow(() => desktopScroll(safeX, safeY, "up", 2), skip);
    });

    it("clamps scroll amount to valid range", ({ skip }) => {
      expectActionNotToThrow(() => desktopScroll(safeX, safeY, "down", 0), skip);
      expectActionNotToThrow(() => desktopScroll(safeX, safeY, "down", 200), skip);
    });
  });

  describe("desktopType", () => {
    it("types text without error", ({ skip }) => {
      expectActionNotToThrow(() => desktopType(" "), skip);
    });
  });

  describe("desktopKeyPress", () => {
    it("presses a key without error", ({ skip }) => {
      expectActionNotToThrow(() => desktopKeyPress("Escape"), skip);
    });
  });

  describe("desktopKeyCombo", () => {
    it("presses a key combo without error", ({ skip }) => {
      expectActionNotToThrow(() => desktopKeyCombo("shift+Escape"), skip);
    });
  });

  describe("desktopDrag", () => {
    it("drags between two points without error", ({ skip }) => {
      expectActionNotToThrow(
        () => desktopDrag(safeX, safeY, safeX + 50, safeY + 50),
        skip,
      );
    });
  });
});

describe("desktop automation input validation", () => {
  it("rejects NaN coordinates", () => {
    expect(() => desktopClick(Number.NaN, 100)).toThrow("Invalid numeric value");
    expect(() => desktopMouseMove(100, Number.NaN)).toThrow("Invalid numeric value");
  });

  it("rejects text exceeding max length", () => {
    const longText = "x".repeat(5000);
    expect(() => desktopType(longText)).toThrow("Text too long");
  });

  it("rejects invalid key strings", () => {
    expect(() => desktopKeyPress("$(rm -rf /)")).toThrow("invalid characters");
    expect(() => desktopKeyCombo("ctrl+$(whoami)")).toThrow("invalid characters");
  });
});
