/**
 * Guards standalone source-checkout startup against stale generated workspace
 * artifacts. The integration-backed child imports the required SQL plugin with
 * the same Bun condition as `bun run start`; manifest assertions keep its
 * nearest tsconfig from redirecting runtime imports into declaration output.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AGENT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REPO_ROOT = path.resolve(AGENT_ROOT, "../..");
const PLUGIN_SQL_SOURCE_ROOT = path.join(REPO_ROOT, "plugins/plugin-sql/src");

describe("standalone source-checkout start contract", () => {
  it("runs the agent and its required SQL plugin against workspace source", () => {
    const agentPackage = JSON.parse(
      readFileSync(path.join(AGENT_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const pluginSqlTsconfig = JSON.parse(
      readFileSync(path.join(PLUGIN_SQL_SOURCE_ROOT, "tsconfig.json"), "utf8"),
    ) as { compilerOptions?: { paths?: Record<string, string[]> } };
    const pluginSqlTypecheckConfig = JSON.parse(
      readFileSync(
        path.join(PLUGIN_SQL_SOURCE_ROOT, "tsconfig.typecheck.json"),
        "utf8",
      ),
    ) as { compilerOptions?: { paths?: Record<string, string[]> } };

    expect(agentPackage.scripts?.start).toBe(
      "bun --no-install --conditions=eliza-source src/bin.ts",
    );
    expect(pluginSqlTsconfig.compilerOptions?.paths).toBeUndefined();
    expect(
      pluginSqlTypecheckConfig.compilerOptions?.paths?.["@elizaos/core"],
    ).toEqual(["../../../packages/core/dist/index.d.ts"]);

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
});
