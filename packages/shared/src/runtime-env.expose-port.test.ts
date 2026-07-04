import { describe, expect, it } from "vitest";
import { API_EXPOSE_PORT_KEYS, resolveApiExposePort } from "./runtime-env";

describe("resolveApiExposePort", () => {
  it("uses ELIZA_API_EXPOSE_PORT as its single key", () => {
    expect(API_EXPOSE_PORT_KEYS).toEqual(["ELIZA_API_EXPOSE_PORT"]);
  });

  it.each([
    "1",
    "true",
    "yes",
    "y",
    "on",
    "enabled",
    " true ",
  ])("returns true for truthy value: %s", (value) => {
    expect(resolveApiExposePort({ ELIZA_API_EXPOSE_PORT: value })).toBe(true);
  });

  it.each([
    "0",
    "false",
    "no",
    "off",
    "disabled",
    "",
    "  ",
    "maybe",
  ])("returns false for non-truthy value: %s", (value) => {
    expect(resolveApiExposePort({ ELIZA_API_EXPOSE_PORT: value })).toBe(false);
  });

  it("returns false when the env var is unset", () => {
    expect(resolveApiExposePort({})).toBe(false);
  });
});
