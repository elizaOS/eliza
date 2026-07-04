/**
 * Command-normalization tests for browser workspace aliases and defaults.
 */

import { describe, expect, it } from "vitest";
import type { BrowserWorkspaceCommand } from "../actions/browser.ts";
import { normalizeBrowserWorkspaceCommand } from "./browser-workspace-helpers.ts";

/**
 * `normalizeBrowserWorkspaceCommand` canonicalizes a browser workspace command
 * before it is dispatched (#10333 — shipped untested). It resolves subaction
 * aliases (goto→navigate, read→get) case-insensitively, coalesces the
 * timeout from `timeoutMs` / `ms` / `milliseconds`, and recurses into nested
 * `steps`. A regression here silently routes a command to the wrong browser op
 * or drops a timeout, so each path is pinned.
 */
const cmd = (o: Record<string, unknown>): BrowserWorkspaceCommand =>
  o as unknown as BrowserWorkspaceCommand;

describe("normalizeBrowserWorkspaceCommand", () => {
  it("maps the goto / read subaction aliases", () => {
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ subaction: "goto" })).subaction,
    ).toBe("navigate");
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ subaction: "read" })).subaction,
    ).toBe("get");
  });

  it("resolves aliases case-insensitively and trims", () => {
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ subaction: "  GOTO " })).subaction,
    ).toBe("navigate");
  });

  it("leaves a non-aliased subaction unchanged", () => {
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ subaction: "click" })).subaction,
    ).toBe("click");
  });

  it("falls back to the `operation` field when subaction is absent", () => {
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ operation: "goto" })).subaction,
    ).toBe("navigate");
  });

  it("coalesces the timeout from timeoutMs → ms → milliseconds", () => {
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ timeoutMs: 1000, ms: 9999 }))
        .timeoutMs,
    ).toBe(1000);
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ ms: "1500" })).timeoutMs,
    ).toBe(1500);
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ milliseconds: 2000 })).timeoutMs,
    ).toBe(2000);
  });

  it("normalizes nested steps recursively", () => {
    const out = normalizeBrowserWorkspaceCommand(
      cmd({
        subaction: "sequence",
        steps: [{ subaction: "goto" }, { subaction: "read" }],
      }),
    );
    const steps = out.steps as BrowserWorkspaceCommand[];
    expect(steps[0].subaction).toBe("navigate");
    expect(steps[1].subaction).toBe("get");
  });
});
