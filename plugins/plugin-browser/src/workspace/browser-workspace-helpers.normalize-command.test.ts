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

  it("falls back to `operation` for a non-alias op and maps its aliases too", () => {
    // Regression (#22194): a documented `operation` alias with any op other
    // than goto/read must resolve to that op, not silently drop to undefined
    // and hit the router's `default` Unsupported branch.
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ operation: "click" })).subaction,
    ).toBe("click");
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ operation: "fill" })).subaction,
    ).toBe("fill");
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ operation: "read" })).subaction,
    ).toBe("get");
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ operation: "LIST" })).subaction,
    ).toBe("list");
  });

  it("treats a whitespace-only subaction as absent and honors operation", () => {
    // Regression (#22194): a trimmed-empty `subaction` must not mask a valid
    // `operation`; it previously restored the raw whitespace and hit the
    // router's Unsupported branch.
    expect(
      normalizeBrowserWorkspaceCommand(
        cmd({ subaction: "   ", operation: "click" }),
      ).subaction,
    ).toBe("click");
    expect(
      normalizeBrowserWorkspaceCommand(
        cmd({ subaction: "\t\n", operation: " GOTO " }),
      ).subaction,
    ).toBe("navigate");
  });

  it("lets a non-empty subaction take precedence over operation", () => {
    // Pin the collision/precedence contract: when both fields are present and
    // non-empty, `subaction` wins and is still canonicalized.
    expect(
      normalizeBrowserWorkspaceCommand(
        cmd({ subaction: "CLICK", operation: "fill" }),
      ).subaction,
    ).toBe("click");
    expect(
      normalizeBrowserWorkspaceCommand(
        cmd({ subaction: 42, operation: " FILL " }),
      ).subaction,
    ).toBe("fill");
  });

  it("canonicalizes case and whitespace for a non-alias subaction", () => {
    // Regression (#22194): a non-lowercase/untrimmed subaction was passed
    // through raw, so the router's lowercase switch cases missed it.
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ subaction: "CLICK" })).subaction,
    ).toBe("click");
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ subaction: "  fill  " }))
        .subaction,
    ).toBe("fill");
    expect(
      normalizeBrowserWorkspaceCommand(cmd({ subaction: " Realistic-Click " }))
        .subaction,
    ).toBe("realistic-click");
  });

  it("normalizes nested steps that carry an `operation` alias", () => {
    const out = normalizeBrowserWorkspaceCommand(
      cmd({
        subaction: "sequence",
        steps: [{ operation: "click" }, { subaction: "  FILL " }],
      }),
    );
    const steps = out.steps as BrowserWorkspaceCommand[];
    expect(steps[0].subaction).toBe("click");
    expect(steps[1].subaction).toBe("fill");
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
