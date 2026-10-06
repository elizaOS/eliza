/** Discovery recognizes imports rather than embedded subprocess programs. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverScriptTestLanes } from "./script-test-lanes.ts";

test("new nested tests join their runner and embedded imports do not change ownership", () => {
  const root = mkdtempSync(path.join(tmpdir(), "script-lanes-"));
  try {
    mkdirSync(path.join(root, "scripts/nested"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts/a.test.ts"),
      'import test from "node:test"; import type { TestContext } from "vitest"; const program = `import { mock } from "bun:test";`;',
    );
    writeFileSync(
      path.join(root, "scripts/nested/b.spec.ts"),
      'import { test } from "bun:test";',
    );
    writeFileSync(
      path.join(root, "scripts/c.test.mjs"),
      'import { it } from "vitest";',
    );
    assert.deepEqual(discoverScriptTestLanes(root), {
      "node:test": ["scripts/a.test.ts"],
      "bun:test": ["scripts/nested/b.spec.ts"],
      vitest: ["scripts/c.test.mjs"],
    });
    writeFileSync(
      path.join(root, "scripts/unknown.test.ts"),
      "export const missingRunner = true;",
    );
    assert.throws(() => discoverScriptTestLanes(root), /exactly one runner/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
