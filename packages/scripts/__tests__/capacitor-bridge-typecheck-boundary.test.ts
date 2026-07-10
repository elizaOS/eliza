/**
 * Pins the Capacitor bridge's package-local typecheck to its mobile boundary
 * shims so it never pulls the agent's optional plugin graph into a leaf task.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dispatchRoute as dispatchApiRoute } from "../../../plugins/plugin-capacitor-bridge/src/type-shims/agent-api.ts";
import {
  configFileExists,
  dispatchRoute as dispatchRootRoute,
  hasPersistedFirstRunState,
  loadElizaConfig,
  saveElizaConfig,
  startEliza,
} from "../../../plugins/plugin-capacitor-bridge/src/type-shims/agent-root.ts";

const repoRoot = resolve(import.meta.dir, "../../..");

test("bridge typecheck uses the same agent shims as declaration builds", () => {
  const bridgePackage = JSON.parse(
    readFileSync(
      resolve(repoRoot, "plugins/plugin-capacitor-bridge/package.json"),
      "utf8",
    ),
  );
  const buildConfig = JSON.parse(
    readFileSync(
      resolve(repoRoot, "plugins/plugin-capacitor-bridge/tsconfig.build.json"),
      "utf8",
    ),
  );

  expect(bridgePackage.scripts.typecheck).toBe(
    "tsgo --noEmit -p tsconfig.build.json",
  );
  expect(buildConfig.compilerOptions.paths).toMatchObject({
    "@elizaos/agent": ["./src/type-shims/agent-root.ts"],
    "@elizaos/agent/api": ["./src/type-shims/agent-api.ts"],
    "@elizaos/agent/runtime": ["./src/type-shims/agent-runtime.ts"],
  });
  expect(
    bridgePackage.devDependencies["@elizaos/plugin-anthropic"],
  ).toBeUndefined();
});

test("type-only bridge shims fail fast if runtime resolution reaches them", () => {
  const guards = [
    dispatchApiRoute,
    dispatchRootRoute,
    startEliza,
    configFileExists,
    loadElizaConfig,
    saveElizaConfig,
    hasPersistedFirstRunState,
  ];

  for (const guard of guards) {
    expect(() => guard({} as never)).toThrow("Type shim only");
  }
});
