/**
 * Button primitive coverage for the shared touch-target floor. The assertions
 * stay at the variant-class boundary because real geometry is enforced by the
 * app and widget certification sweeps.
 */
import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

describe("buttonVariants", () => {
  it.each([
    "default",
    "sm",
    "icon",
    "icon-sm",
  ] as const)("adds the coarse-pointer 44px floor for compact %s buttons", (size) => {
    const className = buttonVariants({ size });

    expect(className).toContain("pointer-coarse:min-h-touch");
    expect(className).toContain("pointer-coarse:min-w-touch");
  });
});
