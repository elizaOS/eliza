/**
 * Boundary tests for the self-edit path denylist exported by
 * `./self-edit.ts`. Harness: deterministic unit tests over the exported
 * predicate — no runtime, network, or filesystem access.
 */
import { describe, expect, it } from "vitest";
import {
  getSelfEditDeniedSuffixes,
  isSelfEditPathDenied,
} from "./self-edit.js";

describe("isSelfEditPathDenied", () => {
  it("denies each live self-edit safety-rail file", () => {
    expect(isSelfEditPathDenied("/repo/packages/host/src/self-edit.ts")).toBe(
      true,
    );
    expect(isSelfEditPathDenied("/repo/packages/host/src/restart.ts")).toBe(
      true,
    );
    expect(
      isSelfEditPathDenied("/repo/packages/host/src/process-guards.ts"),
    ).toBe(true);
    expect(
      isSelfEditPathDenied("/repo/packages/agent/src/actions/runtime.ts"),
    ).toBe(true);
    expect(isSelfEditPathDenied("/repo/packages/app/scripts/run-node.ts")).toBe(
      true,
    );
    expect(
      isSelfEditPathDenied("/repo/packages/app/scripts/lib/restart-guard.ts"),
    ).toBe(true);
  });

  it("denies the exit-75 rate-limit guard on Windows-style separators", () => {
    expect(
      isSelfEditPathDenied(
        "C:\\repo\\packages\\app\\scripts\\lib\\restart-guard.ts",
      ),
    ).toBe(true);
  });

  it("denies every suffix exposed by getSelfEditDeniedSuffixes", () => {
    for (const suffix of getSelfEditDeniedSuffixes()) {
      expect(isSelfEditPathDenied(`/repo/${suffix}`)).toBe(true);
    }
  });

  it("denies any path containing a .git segment", () => {
    expect(isSelfEditPathDenied("/repo/.git/config")).toBe(true);
    expect(
      isSelfEditPathDenied("/repo/packages/core/.git/hooks/pre-commit"),
    ).toBe(true);
    expect(isSelfEditPathDenied(".git/index")).toBe(true);
  });

  it("allows ordinary repository files", () => {
    expect(isSelfEditPathDenied("/repo/packages/core/src/runtime.ts")).toBe(
      false,
    );
    expect(isSelfEditPathDenied("/repo/README.md")).toBe(false);
  });

  it("returns false for empty or non-string input instead of throwing", () => {
    expect(isSelfEditPathDenied("")).toBe(false);
    expect(isSelfEditPathDenied("   ")).toBe(false);
    expect(isSelfEditPathDenied(undefined as unknown as string)).toBe(false);
    expect(isSelfEditPathDenied(42 as unknown as string)).toBe(false);
  });
});
