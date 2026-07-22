/**
 * Guards the standalone benchmark-server launcher against resolving TypeScript
 * declaration aliases as executable modules. It exercises the exact Node/tsx
 * source condition used by the package script and ElizaServerManager.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "../..");

describe("benchmark server launcher", () => {
  it("uses the executable root tsconfig and resolves agent runtime exports", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["benchmark:server"]).toBe(
      "TSX_TSCONFIG_PATH=../../tsconfig.json node --conditions=eliza-source --import tsx src/server.ts",
    );

    const probe = spawnSync(
      "node",
      [
        "--conditions=eliza-source",
        "--import",
        "tsx",
        "-e",
        "import('@elizaos/agent/runtime/plugin-types').then((module) => { if (typeof module.resolveElizaPluginImportSpecifier !== 'function') process.exit(2); })",
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
        },
      },
    );

    expect(probe.status, probe.stderr || probe.stdout).toBe(0);
  });
});
