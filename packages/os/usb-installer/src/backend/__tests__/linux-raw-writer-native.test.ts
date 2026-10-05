import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.runIf(process.platform === "linux")(
  "builds the packaged raw writer warning-free and refuses missing arguments",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "elizaos-raw-writer-"));
    try {
      const binary = join(directory, "linux-raw-writer");
      execFileSync(
        "bash",
        [
          resolve(import.meta.dirname, "../../../native/build-raw-writer.sh"),
          binary,
        ],
        { timeout: 15_000 },
      );
      const result = spawnSync(binary, [], {
        input: Buffer.alloc(0),
        timeout: 5_000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout.length).toBe(0);
      expect(result.stderr.toString()).toContain("elizaOS raw writer failed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
