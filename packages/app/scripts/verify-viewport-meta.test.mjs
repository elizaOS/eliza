/** Tests the emitted viewport verifier with hosted, native, and invalid shells. */
import { describe, expect, it } from "vitest";
import { assertViewportMetaPolicy } from "./verify-viewport-meta.mjs";

const shell = (content) =>
  `<html><head><meta name="viewport" content="${content}" /></head></html>`;

describe("assertViewportMetaPolicy", () => {
  it("accepts an uncapped hosted viewport", () => {
    expect(
      assertViewportMetaPolicy(
        shell("width=device-width, initial-scale=1.0, viewport-fit=cover"),
      ),
    ).not.toContain("maximum-scale");
  });

  it.each(["ios", "android"])("accepts the %s native viewport", (target) => {
    expect(() =>
      assertViewportMetaPolicy(
        shell(
          "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover",
        ),
        target,
      ),
    ).not.toThrow();
  });

  it.each([
    "width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover",
    "width=device-width, initial-scale=1.0, user-scalable=0, viewport-fit=cover",
    "width=device-width, initial-scale=1.0, user-scalable=false, viewport-fit=cover",
    "width=device-width, initial-scale=1.0, maximum-scale=1.5, viewport-fit=cover",
    "width=device-width, initial-scale=1.0, maximum-scale=yes, viewport-fit=cover",
  ])("rejects a hosted zoom cap: %s", (content) => {
    expect(() => assertViewportMetaPolicy(shell(content))).toThrow(
      /allow user-agent zoom/,
    );
  });

  it("rejects unresolved, missing, and duplicate viewport metadata", () => {
    expect(() =>
      assertViewportMetaPolicy(shell("__APP_VIEWPORT_CONTENT__")),
    ).toThrow(/token/);
    expect(() => assertViewportMetaPolicy("<html></html>")).toThrow(
      /exactly one/,
    );
    expect(() =>
      assertViewportMetaPolicy(
        `${shell("width=device-width")}${shell("width=device-width")}`,
      ),
    ).toThrow(/exactly one/);
    expect(() =>
      assertViewportMetaPolicy(
        shell(
          "width=device-width, width=device-width, initial-scale=1.0, viewport-fit=cover",
        ),
      ),
    ).toThrow(/duplicated/);
  });
});
