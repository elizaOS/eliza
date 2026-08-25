/**
 * Guards standalone source-checkout startup against stale generated workspace
 * artifacts. The integration-backed child imports the required SQL plugin and
 * verifies the agent entry point with the same Bun conditions as
 * `bun run start`.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AGENT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("standalone source-checkout start contract", () => {
  it("imports the required SQL plugin against workspace source", () => {
    const imported = spawnSync(
      "bun",
      [
        "--no-install",
        "--conditions=eliza-source",
        "-e",
        'await import("@elizaos/plugin-sql"); console.log("plugin-sql-source-ok")',
      ],
      {
        cwd: AGENT_ROOT,
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(imported.error).toBeUndefined();
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toContain("plugin-sql-source-ok");
  });

  it("runs the agent CLI entry point against workspace source", () => {
    const executed = spawnSync(
      "bun",
      ["--no-install", "--conditions=eliza-source", "src/bin.ts", "--help"],
      {
        cwd: AGENT_ROOT,
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(executed.error).toBeUndefined();
    expect(executed.status, executed.stderr).toBe(0);
    expect(executed.stdout).toContain("eliza-autonomous");
    expect(executed.stdout).toContain("Usage:");
  });
});
