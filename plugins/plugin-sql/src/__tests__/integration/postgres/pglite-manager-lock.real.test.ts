import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PGLITE_ERROR_CODES } from "../../../pglite/errors";
import { PGliteClientManager } from "../../../pglite/manager";

describe("PGliteClientManager file lock", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a second manager for the same file-backed data dir", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "eliza-pglite-lock-"));
    tempDirs.push(dataDir);

    const first = new PGliteClientManager({ dataDir });
    try {
      let error: unknown;
      try {
        new PGliteClientManager({ dataDir });
      } catch (err) {
        error = err;
      }

      expect((error as { code?: string }).code).toBe(PGLITE_ERROR_CODES.ACTIVE_LOCK);
    } finally {
      await first.close();
    }

    const second = new PGliteClientManager({ dataDir });
    await second.close();
  });
});
