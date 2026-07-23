/**
 * Coverage lane composing the ElizaSandboxService suites for the changed-file
 * gate (#16639) — the snapshot-hydration budgets live in a 6k-line service
 * whose lifecycle surface spans these co-located suites; only their UNION
 * exercises the class.
 */
import { describe, expect, test } from "bun:test";
// The __tests__ quota/refund suites are deliberately NOT composed: their
// PGlite/module state collides with eliza-sandbox.test.ts in one process
// (the same class of interference CI's process-isolated list exists for).
// shared-billing is not composed either: its fetch stubbing bleeds into the
// main suite's shared-runtime bridge cases under one process.
import "./eliza-sandbox-agent-router.test.ts";
import "./eliza-sandbox-bridge-ssrf.test.ts";
import "./eliza-sandbox.test.ts";

describe("eliza-sandbox composite lane", () => {
  test("runs under bun with its composed suites", () => {
    expect(typeof test).toBe("function");
  });
});
