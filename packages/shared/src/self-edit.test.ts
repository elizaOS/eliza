/**
 * Unit tests for developer self-edit feature gate and path denylist.
 */

import { describe, expect, it } from "vitest";
import {
  DEV_MODE_ENV,
  getSelfEditDeniedSuffixes,
  isSelfEditEnabled,
  isSelfEditPathDenied,
  SELF_EDIT_ENABLE_ENV,
} from "./self-edit.js";

describe("isSelfEditEnabled", () => {
  it("returns false when ELIZA_ENABLE_SELF_EDIT is missing or falsey", () => {
    expect(isSelfEditEnabled({})).toBe(false);
    expect(isSelfEditEnabled({ [SELF_EDIT_ENABLE_ENV]: "0" })).toBe(false);
    expect(isSelfEditEnabled({ [SELF_EDIT_ENABLE_ENV]: "false" })).toBe(false);
    expect(isSelfEditEnabled({ [SELF_EDIT_ENABLE_ENV]: "" })).toBe(false);
  });

  it("returns true in non-production when opted in", () => {
    expect(
      isSelfEditEnabled({
        [SELF_EDIT_ENABLE_ENV]: "1",
        NODE_ENV: "development",
      }),
    ).toBe(true);

    expect(
      isSelfEditEnabled({
        [SELF_EDIT_ENABLE_ENV]: "true",
      }),
    ).toBe(true);
  });

  it("blocks self-edit in production unless DEV_MODE_ENV is set", () => {
    // Production without dev mode -> disabled
    expect(
      isSelfEditEnabled({
        [SELF_EDIT_ENABLE_ENV]: "1",
        NODE_ENV: "production",
      }),
    ).toBe(false);

    // Production with explicit dev mode override -> enabled
    expect(
      isSelfEditEnabled({
        [SELF_EDIT_ENABLE_ENV]: "1",
        NODE_ENV: "production",
        [DEV_MODE_ENV]: "1",
      }),
    ).toBe(true);
  });
});

describe("isSelfEditPathDenied", () => {
  it("returns false on invalid or empty path inputs", () => {
    // @ts-expect-error test non-string input
    expect(isSelfEditPathDenied(null)).toBe(false);
    // @ts-expect-error test non-string input
    expect(isSelfEditPathDenied(undefined)).toBe(false);
    expect(isSelfEditPathDenied("")).toBe(false);
    expect(isSelfEditPathDenied("   ")).toBe(false);
  });

  it("denies access to .git directories and metadata files", () => {
    expect(isSelfEditPathDenied(".git")).toBe(true);
    expect(isSelfEditPathDenied(".git/config")).toBe(true);
    expect(isSelfEditPathDenied("/project/.git/HEAD")).toBe(true);
    expect(isSelfEditPathDenied("/project/.git/hooks/pre-commit")).toBe(true);
    expect(isSelfEditPathDenied("C:\\repo\\.git\\index")).toBe(true);
  });

  it("denies access to protected safety rails and runner scripts", () => {
    const deniedSuffixes = getSelfEditDeniedSuffixes();
    expect(deniedSuffixes).toContain("packages/shared/src/self-edit.ts");
    expect(deniedSuffixes).toContain("packages/shared/src/restart.ts");
    expect(deniedSuffixes).toContain("packages/agent/src/actions/restart.ts");
    expect(deniedSuffixes).toContain("scripts/run-node.mjs");
    expect(deniedSuffixes).toContain("packages/app-core/scripts/run-node.mjs");

    for (const suffix of deniedSuffixes) {
      expect(isSelfEditPathDenied(`/var/app/${suffix}`)).toBe(true);
      expect(isSelfEditPathDenied(suffix)).toBe(true);
      // Windows-style backslash paths
      expect(
        isSelfEditPathDenied(`C:\\eliza\\${suffix.replace(/\//g, "\\")}`),
      ).toBe(true);
    }
  });

  it("allows modifications to regular source and plugin files", () => {
    expect(isSelfEditPathDenied("/workspace/packages/core/src/index.ts")).toBe(
      false,
    );
    expect(
      isSelfEditPathDenied("/workspace/plugins/plugin-x/src/index.ts"),
    ).toBe(false);
    expect(
      isSelfEditPathDenied("/workspace/packages/app/src/components/Chat.tsx"),
    ).toBe(false);
  });
});
