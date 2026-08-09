/**
 * Locks filtered scenario-runner typechecking behind the UI's optional native
 * runtime declaration build, which Turbo cannot infer from the package graph.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TURBO_JSON = fileURLToPath(
  new URL("../../../turbo.json", import.meta.url),
);
const UI_PACKAGE_JSON = fileURLToPath(
  new URL("../../ui/package.json", import.meta.url),
);
const IOS_LOCAL_AGENT_TRANSPORT = fileURLToPath(
  new URL("../../ui/src/api/ios-local-agent-transport.ts", import.meta.url),
);
const CAPACITOR_BUN_RUNTIME = "@elizaos/capacitor-bun-runtime";
const SCENARIO_RUNNER_TYPECHECK = "@elizaos/scenario-runner#typecheck";

describe("scenario-runner filtered typecheck graph", () => {
  test("builds optional native runtime declarations before typechecking", () => {
    const turbo = JSON.parse(readFileSync(TURBO_JSON, "utf8"));
    const uiPackage = JSON.parse(readFileSync(UI_PACKAGE_JSON, "utf8"));
    const uiSource = readFileSync(IOS_LOCAL_AGENT_TRANSPORT, "utf8");

    expect(uiPackage.optionalDependencies[CAPACITOR_BUN_RUNTIME]).toBe(
      "workspace:*",
    );
    expect(uiSource).toMatch(
      /import\(\s*["']@elizaos\/capacitor-bun-runtime["']\s*\)/,
    );

    const task = turbo.tasks[SCENARIO_RUNNER_TYPECHECK];
    expect(task).toBeDefined();
    expect(task.dependsOn).toContain(`${CAPACITOR_BUN_RUNTIME}#build`);
  });
});
