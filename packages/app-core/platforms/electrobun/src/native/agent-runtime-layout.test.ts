/** Exercises agent runtime layout behavior with deterministic app-core test fixtures. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isStartupDiagnosticsOwnedByBundle,
  resolveRuntimeEntryPath,
} from "./agent";

const tmpDirs: string[] = [];

function makeRuntimeDist(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "example-runtime-layout-"),
  );
  tmpDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("desktop runtime layout", () => {
  it("prefers root entry.js when both runtime layouts exist", () => {
    const root = makeRuntimeDist();
    const rootEntry = path.join(root, "entry.js");
    fs.writeFileSync(rootEntry, "");
    fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(root, "runtime", "entry.js"), "");

    expect(resolveRuntimeEntryPath(root)).toBe(rootEntry);
  });

  it("accepts packaged runtime/entry.js layout", () => {
    const root = makeRuntimeDist();
    const runtimeEntry = path.join(root, "runtime", "entry.js");
    fs.mkdirSync(path.dirname(runtimeEntry), { recursive: true });
    fs.writeFileSync(runtimeEntry, "");

    expect(resolveRuntimeEntryPath(root)).toBe(runtimeEntry);
  });
});

describe("startup diagnostics ownership", () => {
  it("accepts a failure written by the current bundle", () => {
    expect(
      isStartupDiagnosticsOwnedByBundle(
        { ownerBundlePath: "/Applications/Eliza.app" },
        "/Applications/Eliza.app",
      ),
    ).toBe(true);
  });

  it("rejects another dev worktree and legacy unowned records", () => {
    expect(
      isStartupDiagnosticsOwnedByBundle(
        { ownerBundlePath: "/tmp/old-worktree/Eliza-dev.app" },
        "/tmp/current-worktree/Eliza-dev.app",
      ),
    ).toBe(false);
    expect(
      isStartupDiagnosticsOwnedByBundle(
        { ownerBundlePath: null },
        "/tmp/current-worktree/Eliza-dev.app",
      ),
    ).toBe(false);
    expect(
      isStartupDiagnosticsOwnedByBundle(
        { ownerBundlePath: "/tmp/current-worktree/Eliza-dev.app" },
        null,
      ),
    ).toBe(false);
  });
});
