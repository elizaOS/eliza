import { describe, expect, it } from "vitest";
import {
  DEV_MODE_ENV,
  getSelfEditDeniedSuffixes,
  isSelfEditEnabled,
  isSelfEditPathDenied,
  SELF_EDIT_ENABLE_ENV,
} from "../src/self-edit";

describe("isSelfEditEnabled", () => {
  it("returns false when no env vars are set", () => {
    expect(isSelfEditEnabled({})).toBe(false);
  });

  it("returns false when only the opt-in flag is set in production", () => {
    expect(
      isSelfEditEnabled({
        [SELF_EDIT_ENABLE_ENV]: "1",
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });

  it("returns true when opt-in flag is set in development (NODE_ENV=development)", () => {
    expect(
      isSelfEditEnabled({
        [SELF_EDIT_ENABLE_ENV]: "1",
        NODE_ENV: "development",
      }),
    ).toBe(true);
  });

  it("returns true when opt-in flag is set with no NODE_ENV", () => {
    expect(
      isSelfEditEnabled({
        [SELF_EDIT_ENABLE_ENV]: "1",
      }),
    ).toBe(true);
  });

  it("returns true when opt-in + MILADY_DEV_MODE override production", () => {
    expect(
      isSelfEditEnabled({
        [SELF_EDIT_ENABLE_ENV]: "1",
        [DEV_MODE_ENV]: "1",
        NODE_ENV: "production",
      }),
    ).toBe(true);
  });

  it("returns false when opt-in is missing even with MILADY_DEV_MODE=1", () => {
    expect(
      isSelfEditEnabled({
        [DEV_MODE_ENV]: "1",
        NODE_ENV: "development",
      }),
    ).toBe(false);
  });

  it("accepts assorted truthy strings for the opt-in flag", () => {
    for (const val of ["1", "true", "yes", "on", "enabled", "TRUE"]) {
      expect(
        isSelfEditEnabled({
          [SELF_EDIT_ENABLE_ENV]: val,
          NODE_ENV: "development",
        }),
      ).toBe(true);
    }
  });

  it("rejects falsy / empty values for the opt-in flag", () => {
    for (const val of ["0", "false", "no", "", "  "]) {
      expect(
        isSelfEditEnabled({
          [SELF_EDIT_ENABLE_ENV]: val,
          NODE_ENV: "development",
        }),
      ).toBe(false);
    }
  });

  it("does not throw and returns false when called with no args", () => {
    // Smoke: real process.env should not crash the helper.
    expect(typeof isSelfEditEnabled()).toBe("boolean");
  });
});

describe("isSelfEditPathDenied", () => {
  it("returns false for empty / non-string input", () => {
    expect(isSelfEditPathDenied("")).toBe(false);
    expect(isSelfEditPathDenied("   ")).toBe(false);
    // Intentionally exercise the runtime guard against non-string inputs.
    expect(isSelfEditPathDenied(undefined as unknown as string)).toBe(false);
  });

  it("denies edits to the dev-mode gate file", () => {
    expect(
      isSelfEditPathDenied(
        "/Users/me/repo/eliza/packages/shared/src/self-edit.ts",
      ),
    ).toBe(true);
  });

  it("denies edits to the restart action", () => {
    expect(
      isSelfEditPathDenied(
        "/Users/me/repo/eliza/packages/agent/src/actions/restart.ts",
      ),
    ).toBe(true);
  });

  it("denies edits to the shared restart helper", () => {
    expect(
      isSelfEditPathDenied(
        "/Users/me/repo/eliza/packages/shared/src/restart.ts",
      ),
    ).toBe(true);
  });

  it("denies edits to the runner script under app-core/scripts", () => {
    expect(
      isSelfEditPathDenied(
        "/Users/me/repo/eliza/packages/app-core/scripts/run-node.mjs",
      ),
    ).toBe(true);
  });

  it("denies edits to scripts/run-node.mjs at any prefix", () => {
    expect(isSelfEditPathDenied("/anything/scripts/run-node.mjs")).toBe(true);
  });

  it("denies anything under a .git directory", () => {
    expect(isSelfEditPathDenied("/Users/me/repo/.git/HEAD")).toBe(true);
    expect(isSelfEditPathDenied("/Users/me/repo/.git/objects/ab/cdef")).toBe(
      true,
    );
    expect(
      isSelfEditPathDenied("/Users/me/repo/eliza/.git/refs/heads/main"),
    ).toBe(true);
  });

  it("denies a bare .git directory path", () => {
    expect(isSelfEditPathDenied("/Users/me/repo/.git")).toBe(true);
    expect(isSelfEditPathDenied(".git")).toBe(true);
    expect(isSelfEditPathDenied(".git/HEAD")).toBe(true);
  });

  it("does not deny normal source paths", () => {
    expect(
      isSelfEditPathDenied(
        "/Users/me/repo/eliza/packages/agent/src/actions/scratchpad.ts",
      ),
    ).toBe(false);
    expect(
      isSelfEditPathDenied("/Users/me/repo/plugins/app-lifeops/src/index.ts"),
    ).toBe(false);
    expect(
      isSelfEditPathDenied(
        "/Users/me/repo/eliza/packages/shared/src/restart-other.ts",
      ),
    ).toBe(false);
  });

  it("does not deny files that merely contain '.git' in the name (not as a segment)", () => {
    expect(
      isSelfEditPathDenied("/Users/me/repo/eliza/packages/agent/src/.gitkeep"),
    ).toBe(false);
    expect(
      isSelfEditPathDenied(
        "/Users/me/repo/eliza/packages/agent/src/foo.gitignore",
      ),
    ).toBe(false);
  });

  it("normalizes Windows-style separators", () => {
    expect(
      isSelfEditPathDenied(
        "C:\\Users\\me\\repo\\eliza\\packages\\shared\\src\\self-edit.ts",
      ),
    ).toBe(true);
    expect(isSelfEditPathDenied("C:\\Users\\me\\repo\\.git\\HEAD")).toBe(true);
  });

  it("does not deny lookalike suffixes that are not full segment matches", () => {
    // `xrestart.ts` should not match `restart.ts`.
    expect(
      isSelfEditPathDenied(
        "/Users/me/repo/eliza/packages/shared/src/xrestart.ts",
      ),
    ).toBe(false);
  });
});

describe("getSelfEditDeniedSuffixes", () => {
  it("returns the canonical denylist including the gate, restart machinery, and runner script", () => {
    const suffixes = getSelfEditDeniedSuffixes();
    expect(suffixes).toContain("packages/shared/src/self-edit.ts");
    expect(suffixes).toContain("packages/shared/src/restart.ts");
    expect(suffixes).toContain("packages/agent/src/actions/restart.ts");
    expect(suffixes).toContain("packages/app-core/scripts/run-node.mjs");
  });
});
