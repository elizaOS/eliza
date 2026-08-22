// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { shellHistory } from "./surface-realm-channel";

describe("shellHistory desktop boot coordinates", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("preserves host-owned params across launcher navigation", () => {
    window.history.replaceState(
      null,
      "",
      "/?apiBase=http%3A%2F%2F127.0.0.1%3A32437&appWindow=1#/chat",
    );

    shellHistory.pushState(null, "", "/notes");

    const navigated = new URL(window.location.href);
    expect(navigated.pathname).toBe("/notes");
    expect(navigated.searchParams.get("apiBase")).toBe(
      "http://127.0.0.1:32437",
    );
    expect(navigated.searchParams.get("appWindow")).toBe("1");
  });

  it("does not copy host params to a cross-origin destination", () => {
    window.history.replaceState(
      null,
      "",
      "/?apiBase=http%3A%2F%2F127.0.0.1%3A32437",
    );

    expect(() =>
      shellHistory.pushState(null, "", "https://example.com/notes"),
    ).toThrow();
  });
});
