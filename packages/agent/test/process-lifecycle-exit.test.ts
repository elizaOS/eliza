/** Real process signals, disk teardown receipts and supervisor exit status. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each(["", "teardown", "reporter"])(
  "drains cleanup and reports shutdown status (%s)",
  (failure) => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-shutdown-"));
    try {
      const receipt = path.join(dir, "receipt");
      const child = spawnSync(
        "bun",
        [
          path.join(import.meta.dirname, "fixtures/process-lifecycle-child.ts"),
          receipt,
          failure,
        ],
        { timeout: 10_000, encoding: "utf8" },
      );
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status, child.stderr).toBe(failure ? 1 : 0);
      expect(readFileSync(receipt, "utf8").trim().split("\n")).toEqual([
        "last",
        "first",
        "sandbox",
        "runtime",
        ...(failure ? ["reported"] : []),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
