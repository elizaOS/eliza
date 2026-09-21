/** Guards required hosted execution of the real replacement/account-deletion contention test. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("agent sandbox replacement lock order", () => {
  test("runs the real PostgreSQL regression as a required hosted gate", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../../../../../../.github/workflows/cloud-tests.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      "packages/cloud/shared/src/db/repositories/__tests__/agent-sandbox-replacement-account-deletion-locks.integration.test.ts",
    );
    expect(workflow).toContain('REQUIRE_REAL_POSTGRES_REPLACEMENT_LOCK_TESTS: "1"');
  });
});
