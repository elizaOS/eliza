/**
 * Boundary tests for the self-edit path denylist exported by
 * `./self-edit.ts`. Harness: deterministic unit tests over the exported
 * predicates — no runtime, network, or filesystem writes; each case passes an
 * explicit environment snapshot so nothing leaks between tests.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getSelfEditDeniedSuffixes,
  isSelfEditPathDenied,
  SELF_EDIT_ENABLE_ENV,
  SELF_EDIT_ROOT_ENV,
} from "./self-edit.js";

/** Live self-edit environment bound to `/repo` as the protected checkout. */
function boundEnv(root = "/repo"): Record<string, string | undefined> {
  return {
    [SELF_EDIT_ENABLE_ENV]: "1",
    NODE_ENV: "development",
    [SELF_EDIT_ROOT_ENV]: root,
  };
}

/** Self-edit enabled but no explicit root: the derivation binds this checkout. */
function enabledEnv(): Record<string, string | undefined> {
  return { [SELF_EDIT_ENABLE_ENV]: "1", NODE_ENV: "development" };
}

describe("isSelfEditPathDenied", () => {
  it("denies each live self-edit safety-rail file inside the bound root", () => {
    const env = boundEnv();
    expect(
      isSelfEditPathDenied("/repo/packages/host/src/self-edit.ts", env),
    ).toBe(true);
    expect(
      isSelfEditPathDenied("/repo/packages/host/src/restart.ts", env),
    ).toBe(true);
    expect(
      isSelfEditPathDenied("/repo/packages/host/src/process-guards.ts", env),
    ).toBe(true);
    expect(
      isSelfEditPathDenied("/repo/packages/agent/src/actions/runtime.ts", env),
    ).toBe(true);
    expect(
      isSelfEditPathDenied("/repo/packages/app/scripts/run-node.ts", env),
    ).toBe(true);
    expect(
      isSelfEditPathDenied(
        "/repo/packages/app/scripts/lib/restart-guard.ts",
        env,
      ),
    ).toBe(true);
  });

  it("denies the exit-75 rate-limit guard on Windows-style separators", () => {
    expect(
      isSelfEditPathDenied(
        "C:\\repo\\packages\\app\\scripts\\lib\\restart-guard.ts",
        boundEnv("C:\\repo"),
      ),
    ).toBe(true);
  });

  it("denies every suffix exposed by getSelfEditDeniedSuffixes", () => {
    const env = boundEnv();
    for (const suffix of getSelfEditDeniedSuffixes()) {
      expect(isSelfEditPathDenied(`/repo/${suffix}`, env)).toBe(true);
    }
  });

  it("denies protected suffixes when the root is derived, not overridden", () => {
    // No ELIZA_SELF_EDIT_ROOT: the root derives from this module's own
    // location (packages/host/src → checkout root), independent of cwd.
    const checkoutRoot = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
    );
    expect(
      isSelfEditPathDenied(
        path.join(checkoutRoot, "packages/host/src/self-edit.ts"),
        enabledEnv(),
      ),
    ).toBe(true);
  });

  it("allows the same suffix in an unrelated workspace (collision case)", () => {
    const env = boundEnv("/repo");
    expect(
      isSelfEditPathDenied(
        "/other-project/packages/host/src/restart.ts",
        env,
      ),
    ).toBe(false);
    expect(
      isSelfEditPathDenied(
        "/other-project/packages/agent/src/actions/runtime.ts",
        env,
      ),
    ).toBe(false);
  });

  it("denies protected suffixes only while the self-edit gate is open", () => {
    const closedEnv: Record<string, string | undefined> = {
      [SELF_EDIT_ROOT_ENV]: "/repo",
    };
    expect(
      isSelfEditPathDenied("/repo/packages/host/src/self-edit.ts", closedEnv),
    ).toBe(false);
  });

  it("denies any path containing a .git segment in any workspace", () => {
    expect(isSelfEditPathDenied("/repo/.git/config", boundEnv())).toBe(true);
    expect(
      isSelfEditPathDenied("/other-project/.git/hooks/pre-commit", boundEnv()),
    ).toBe(true);
    expect(isSelfEditPathDenied(".git/index", {})).toBe(true);
  });

  it("allows ordinary repository files", () => {
    const env = boundEnv();
    expect(
      isSelfEditPathDenied("/repo/packages/core/src/runtime.ts", env),
    ).toBe(false);
    expect(isSelfEditPathDenied("/repo/README.md", env)).toBe(false);
  });

  it("returns false for empty or non-string input instead of throwing", () => {
    const env = boundEnv();
    expect(isSelfEditPathDenied("", env)).toBe(false);
    expect(isSelfEditPathDenied("   ", env)).toBe(false);
    expect(isSelfEditPathDenied(undefined as unknown as string, env)).toBe(
      false,
    );
    expect(isSelfEditPathDenied(42 as unknown as string, env)).toBe(false);
  });
});
