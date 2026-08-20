/**
 * Pins the local plugin smoke runner to repository-root-relative Vitest paths
 * so the live lifecycle test remains discoverable from plugin package scripts.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const runnerPath = fileURLToPath(
  new URL(
    "../../app-core/scripts/run-local-plugin-live-smoke.mjs",
    import.meta.url,
  ),
);
const runner = readFileSync(runnerPath, "utf8");
const realConfig = readFileSync(
  fileURLToPath(new URL("../vitest/real.config.ts", import.meta.url)),
  "utf8",
);

test("uses the repository as Vitest root and repository-relative test paths", () => {
  expect(runner).toContain(
    'const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");',
  );
  expect(runner).toContain(
    '"packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts"',
  );
  expect(runner).toContain('"packages/scripts/vitest/live-e2e.config.ts"');
  expect(runner).not.toContain('"eliza/packages/');
  expect(realConfig).toContain(
    '"scripts",\n  "vitest",\n  "fail-on-silent-skip.setup.ts"',
  );
  expect(realConfig).not.toContain('"test",\n    "vitest"');
});
