/** Concurrent runs own distinct stores; explicit persistent stores remain caller-owned. */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2eDatabaseStore } from "./e2e-database-store.ts";

test("concurrent transient stores and repeated cleanup are independent", () => {
  const first = createE2eDatabaseStore({ root: tmpdir() });
  const second = createE2eDatabaseStore({ root: tmpdir() });
  try {
    expect(first.directory).not.toBe(second.directory);
    writeFileSync(join(second.directory, "data"), "second run");
    first.cleanup();
    first.cleanup();
    expect(existsSync(first.directory)).toBe(false);
    expect(readFileSync(join(second.directory, "data"), "utf8")).toBe(
      "second run",
    );
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("explicit and persistent stores are never deleted by cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-api-store-owner-"));
  try {
    const explicit = createE2eDatabaseStore({ root, directory: "." });
    writeFileSync(join(root, "data"), "caller-owned");
    explicit.cleanup();
    expect(readFileSync(join(root, "data"), "utf8")).toBe("caller-owned");
    const persistent = createE2eDatabaseStore({ root, persistent: true });
    expect(persistent.directory).toBe(
      join(root, ".eliza/.pgdata-cloud-api-e2e"),
    );
    persistent.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
