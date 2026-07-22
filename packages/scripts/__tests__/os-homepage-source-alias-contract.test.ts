/**
 * Locks the OS homepage's source aliases to the transitive language dependency
 * required by the shared UI region helper during clean release builds.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const HOMEPAGE_ROOT = `${REPOSITORY_ROOT}/packages/os/homepage`;

test("OS homepage resolves the UI region helper's shared language primitives", () => {
  const tsconfig = JSON.parse(
    readFileSync(`${HOMEPAGE_ROOT}/tsconfig.app.json`, "utf8"),
  ) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const viteConfig = readFileSync(`${HOMEPAGE_ROOT}/vite.config.ts`, "utf8");

  expect(tsconfig.compilerOptions?.paths?.["@elizaos/shared"]).toEqual([
    "../../shared/src/i18n/language.ts",
  ]);
  expect(viteConfig).toContain("find: /^@elizaos\\/shared$/");
  expect(viteConfig).toContain('"../../shared/src/i18n/language.ts"');
});
