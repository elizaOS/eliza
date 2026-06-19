import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// download.mjs is a node script (no exports); we assert on its source to
// guarantee the safety properties remain in place. If you intentionally
// remove one of these checks, update the test with the new safety guarantee.
const SCRIPT = readFileSync(
  join(__dirname, "..", "..", "vendor", "download.mjs"),
  "utf8",
);

describe("vendor/download.mjs source contract", () => {
  it("computes SHA-256 of every download", () => {
    expect(SCRIPT).toContain('createHash("sha256")');
  });

  it("throws on checksum mismatch (does not silently install)", () => {
    expect(SCRIPT).toContain("hash MISMATCH");
    expect(SCRIPT).toContain("refusing to install unverified");
  });

  it("requires a sibling .sha256 for Sideloader or refuses install", () => {
    expect(SCRIPT).toContain("Sideloader checksum unavailable");
  });

  it("uses argv arrays for unzip/powershell — no shell-string interpolation", () => {
    // Older code used: execAsync(`unzip -oq "${zipPath}" -d "${destDir}"`).
    // Confirm we no longer template paths into a single shell command.
    expect(SCRIPT).not.toMatch(/exec(Async|Sync)\(`unzip /);
    expect(SCRIPT).toContain('runChild("unzip"');
  });

  it("supports --strict and --best-effort modes", () => {
    expect(SCRIPT).toContain('"--strict"');
    expect(SCRIPT).toContain("best-effort");
  });

  it("detects offline state with a HEAD probe", () => {
    expect(SCRIPT).toContain("isOnline");
    expect(SCRIPT).toContain('method: "HEAD"');
  });
});
