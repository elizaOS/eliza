import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSafeCwd } from "../src/sandbox.ts";

/**
 * Tests for the sub-agent cwd sandbox guard (#8801 / #9943). `resolveSafeBinary`
 * and `parseCodexJsonl` are already covered, but `resolveSafeCwd` — the guard
 * that keeps a spawned coding sub-agent's working directory INSIDE an allowed
 * workspace root — had zero assertions. It is a sandbox-escape boundary, so the
 * prefix-bypass case (a sibling dir that merely shares a name prefix) matters.
 */
describe("resolveSafeCwd", () => {
  let parent: string;
  let root: string;
  let nested: string;
  let sibling: string;
  let outside: string;

  beforeAll(() => {
    // Base the dirs under the repo (process.cwd()), NOT the OS temp dir —
    // resolveSafeCwd implicitly allows anything under tmpdir, so the rejection
    // cases must live outside it to be meaningful.
    parent = realpathSync(mkdtempSync(join(process.cwd(), ".cli-inf-sandbox-")));
    root = join(parent, "work");
    nested = join(root, "sub", "deeper");
    sibling = join(parent, "work-evil"); // shares the "work" prefix but is NOT under root
    outside = join(parent, "elsewhere");
    mkdirSync(nested, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });

  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("accepts a cwd that IS the allowed root", () => {
    expect(resolveSafeCwd(root, [root])).toBe(realpathSync(root));
  });

  it("accepts a cwd nested under the allowed root", () => {
    expect(resolveSafeCwd(nested, [root])).toBe(realpathSync(nested));
  });

  it("rejects a sibling that only shares a name prefix (no path-prefix bypass)", () => {
    // "/…/work-evil" must NOT be treated as under "/…/work"
    expect(() => resolveSafeCwd(sibling, [root])).toThrow(/not under any allowed/);
  });

  it("rejects a cwd outside every allowed root", () => {
    expect(() => resolveSafeCwd(outside, [root])).toThrow(/not under any allowed/);
  });

  it("always allows the OS temp dir (the implicit sandbox)", () => {
    const inTmp = realpathSync(mkdtempSync(join(tmpdir(), "cli-inf-tmp-")));
    try {
      expect(resolveSafeCwd(inTmp, [])).toBe(inTmp);
    } finally {
      rmSync(inTmp, { recursive: true, force: true });
    }
  });

  it("rejects a relative cwd", () => {
    expect(() => resolveSafeCwd("relative/dir", [root])).toThrow(/must be absolute/);
  });

  it("rejects an empty cwd", () => {
    expect(() => resolveSafeCwd("", [root])).toThrow(/cwd is required/);
  });

  it("rejects a non-existent cwd", () => {
    expect(() => resolveSafeCwd(join(parent, "does-not-exist"), [root])).toThrow(
      /does not exist or is not a directory/
    );
  });
});
