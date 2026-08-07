/**
 * Unit coverage for `resolveApiExposePort` (`runtime-env.ts`): parses the single
 * `ELIZA_API_EXPOSE_PORT` env key into a boolean, asserting the truthy/falsy value
 * table (with surrounding-whitespace tolerance) and the unset default of false.
 */
import { describe, expect, it } from "vitest";
import { resolveApiExposePort } from "./runtime-env";

describe("resolveApiExposePort", () => {
  it.each(["1", "true", "yes", "y", "on", "enabled", " true "])(
    "returns true for truthy value: %s",
    (value) => {
      expect(resolveApiExposePort({ ELIZA_API_EXPOSE_PORT: value })).toBe(true);
    },
  );

  it.each(["0", "false", "no", "off", "disabled", "", "  ", "maybe"])(
    "returns false for non-truthy value: %s",
    (value) => {
      expect(resolveApiExposePort({ ELIZA_API_EXPOSE_PORT: value })).toBe(
        false,
      );
    },
  );

  it("returns false when the env var is unset", () => {
    expect(resolveApiExposePort({})).toBe(false);
  });
});
