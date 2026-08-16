/**
 * Verifies the compatibility component barrel in a real Node process so
 * browser-only asset imports cannot break server-side plugin discovery.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

describe("component barrel Node compatibility", () => {
  it("loads without requiring a browser CSS loader", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--conditions=eliza-source",
          "--import",
          "tsx",
          "--eval",
          "import('@elizaos/ui/components')",
        ],
        {
          cwd: REPOSITORY_ROOT,
          env: { ...process.env, NODE_NO_WARNINGS: "1" },
          stdio: "pipe",
          timeout: 30_000,
        },
      ),
    ).not.toThrow();
  }, 35_000);
});
