// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildStreamPopoutUrl, openStreamPopout } from "./popout-url";

describe("buildStreamPopoutUrl", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "http://localhost/");
  });

  it("preserves public HTTPS remote agent API bases for stream popouts", () => {
    const url = new URL(buildStreamPopoutUrl("https://your-agent.example.com"));

    expect(url.origin).toBe("http://localhost");
    expect(url.searchParams.has("popout")).toBe(true);
    expect(url.searchParams.get("apiBase")).toBe(
      "https://your-agent.example.com",
    );
  });

  it("omits apiBase when no runtime target is configured", () => {
    const url = new URL(buildStreamPopoutUrl());

    expect(url.searchParams.has("popout")).toBe(true);
    expect(url.searchParams.has("apiBase")).toBe(false);
  });

  it("opens stream popouts with one shared target and feature set", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    openStreamPopout("https://your-agent.example.com");

    expect(open).toHaveBeenCalledWith(
      expect.stringContaining(
        "apiBase=https%3A%2F%2Fyour-agent.example.com",
      ),
      "elizaos-stream",
      "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no",
    );
  });
});
