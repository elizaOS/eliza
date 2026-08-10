/**
 * Verifies the shared Input and Textarea primitives carry the coarse-pointer
 * 16px font-size override that prevents Mobile Safari from focus-zooming form
 * controls below 16px (#18233).
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Input } from "./input";
import { Textarea } from "./textarea";

afterEach(cleanup);

describe("Input coarse-pointer font-size (iOS focus-zoom prevention)", () => {
  it.each(["default", "compact", "relaxed"] as const)(
    "keeps the 16px coarse-pointer override at %s density",
    (density) => {
      render(<Input aria-label="username" density={density} />);
      expect(screen.getByLabelText("username").className).toContain(
        "pointer-coarse:text-[16px]",
      );
    },
  );

  it("preserves the override when a caller selects denser desktop text", () => {
    render(<Input aria-label="username" className="text-xs" />);
    const className = screen.getByLabelText("username").className;
    expect(className).toContain("text-xs");
    expect(className).toContain("pointer-coarse:text-[16px]");
  });
});

describe("Textarea coarse-pointer font-size (iOS focus-zoom prevention)", () => {
  it.each(["default", "compact", "relaxed"] as const)(
    "keeps the 16px coarse-pointer override at %s density",
    (density) => {
      render(<Textarea aria-label="message" density={density} />);
      expect(screen.getByLabelText("message").className).toContain(
        "pointer-coarse:text-[16px]",
      );
    },
  );

  it("preserves the override when a caller selects denser desktop text", () => {
    render(<Textarea aria-label="message" className="text-xs" />);
    const className = screen.getByLabelText("message").className;
    expect(className).toContain("text-xs");
    expect(className).toContain("pointer-coarse:text-[16px]");
  });
});
