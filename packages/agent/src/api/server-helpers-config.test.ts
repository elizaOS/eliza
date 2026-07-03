import { describe, expect, it } from "vitest";
import { isSafeResetStateDir } from "./server-helpers-config";

/**
 * Tests for the destructive-reset guard (#8801 / #9943). isSafeResetStateDir
 * decides whether a path may be wiped by the "reset state" operation. A bug here
 * could erase the filesystem root, $HOME, or an unrelated directory — so the
 * guard (under-home AND contains an "eliza" segment, never root/home itself) is
 * pinned. It was untested.
 */
describe("isSafeResetStateDir", () => {
  const home = "/home/user";

  it("allows a state dir under home that carries an 'eliza' segment", () => {
    expect(isSafeResetStateDir("/home/user/.local/state/eliza", home)).toBe(
      true,
    );
    expect(isSafeResetStateDir("/home/user/eliza", home)).toBe(true);
  });

  it("refuses the filesystem root", () => {
    expect(isSafeResetStateDir("/", home)).toBe(false);
  });

  it("refuses the home directory itself", () => {
    expect(isSafeResetStateDir(home, home)).toBe(false);
  });

  it("refuses any directory outside home (even with an eliza segment)", () => {
    expect(isSafeResetStateDir("/tmp/eliza", home)).toBe(false);
    expect(isSafeResetStateDir("/var/lib/eliza", home)).toBe(false);
  });

  it("refuses a traversal that escapes home", () => {
    expect(isSafeResetStateDir("/home/user/../etc/eliza", home)).toBe(false);
  });

  it("refuses a dir under home that lacks the allowed segment", () => {
    expect(isSafeResetStateDir("/home/user/Documents", home)).toBe(false);
    expect(
      isSafeResetStateDir("/home/user/.local/state/custom-app", home),
    ).toBe(false);
  });
});
