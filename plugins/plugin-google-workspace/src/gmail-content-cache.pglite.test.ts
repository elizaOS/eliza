/** Proves a fresh Bun process can directly resolve Gmail cache rows in PGLite. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-gmail-cache-pglite-"));
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function child(mode: "write" | "read", reference?: string): Record<string, unknown> {
  const result = spawnSync(
    "bun",
    [
      "--conditions=eliza-source",
      path.join(testDir, "gmail-content-cache.pglite-child.ts"),
      mode,
      dataDir,
      ...(reference ? [reference] : []),
    ],
    {
      cwd: path.resolve(testDir, "../../.."),
      env: { ...process.env, ELIZA_PGLITE_STORAGE: "disk" },
      encoding: "utf8",
      timeout: 150_000,
    }
  );
  if (result.status !== 0) {
    throw new Error(`Gmail cache child failed (${mode}): ${result.stderr}\n${result.stdout}`);
  }
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("GMAIL_CACHE_RESULT="));
  if (!line) throw new Error(`Gmail cache child emitted no result: ${result.stdout}`);
  return JSON.parse(line.slice("GMAIL_CACHE_RESULT=".length));
}

describe("Gmail cache PGLite process continuity", () => {
  it("reopens the manifest and reaches a late canary from a fresh process", () => {
    const written = child("write");
    const read = child("read", written.reference as string);
    expect(read).toEqual({
      text: "FRESH-PROCESS-CANARY",
      sourceWork: { headReads: 1, segmentRows: 1 },
    });
  }, 180_000);
});
