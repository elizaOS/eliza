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
  it("includes pointer-coarse:text-[16px] in the base class", () => {
    render(<Input aria-label="username" />);
    expect(screen.getByLabelText("username").className).toContain(
      "pointer-coarse:text-[16px]",
    );
  });

  it("retains text-sm for fine pointers (desktop unchanged)", () => {
    render(<Input aria-label="username" />);
    expect(screen.getByLabelText("username").className).toContain("text-sm");
  });
});

describe("Textarea coarse-pointer font-size (iOS focus-zoom prevention)", () => {
  it("includes pointer-coarse:text-[16px] in the base class", () => {
    render(<Textarea aria-label="message" />);
    expect(screen.getByLabelText("message").className).toContain(
      "pointer-coarse:text-[16px]",
    );
  });

  it("retains text-sm for fine pointers (desktop unchanged)", () => {
    render(<Textarea aria-label="message" />);
    expect(screen.getByLabelText("message").className).toContain("text-sm");
  });
});
