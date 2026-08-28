/**
 * Locks the responsive geometry contract for deliberately compact Button
 * recipes: compact on a fine pointer, at least 44px on a coarse pointer.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, type ButtonProps } from "./button";

afterEach(cleanup);

const compactSizes = [
  ["compact", "h-9"],
  ["dense", "h-8"],
  ["regularCompact", "h-9"],
  ["tiny", "h-7"],
  ["wide", "h-10"],
  ["micro", "h-6"],
  ["tinyWide", "h-7"],
  ["pill", "h-9"],
  ["badge", "h-auto"],
  ["denseWide", "h-8"],
  ["formAction", "h-10"],
  ["disclosure", "size-5"],
  ["pillDense", "h-8"],
  ["inlineIcon", "h-auto"],
  ["icon-xs", "size-6"],
  ["carouselControl", "size-8"],
  ["pageDrawerTrigger", "h-9.5"],
] as const satisfies ReadonlyArray<
  readonly [NonNullable<ButtonProps["size"]>, string]
>;

describe("Button compact touch-target contract", () => {
  it.each(compactSizes)(
    "keeps %s compact on fine pointers and adds the coarse-pointer floor",
    (size, finePointerClass) => {
      render(<Button size={size}>Action</Button>);

      const className = screen.getByRole("button", {
        name: "Action",
      }).className;
      expect(className).toContain(finePointerClass);
      expect(className).toContain("pointer-coarse:min-h-touch");
      expect(className).toContain("pointer-coarse:min-w-touch");
    },
  );

  it("retains the touch floor when a caller narrows the fine-pointer box", () => {
    render(
      <Button size="compact" className="h-7 w-7">
        Action
      </Button>,
    );

    const className = screen.getByRole("button", { name: "Action" }).className;
    expect(className).toContain("h-7");
    expect(className).toContain("w-7");
    expect(className).toContain("pointer-coarse:min-h-touch");
    expect(className).toContain("pointer-coarse:min-w-touch");
  });
});
