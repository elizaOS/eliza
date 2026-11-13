import test from "node:test";
import assert from "node:assert/strict";
import { validateStrictFixtureAuthority } from "./strict-fixture-authority.mjs";
const expected = {
  runId: "123",
  job: "e2e-tests",
  attempt: "1",
  databaseUrl: "postgresql://postgres@127.0.0.1:5432/postgres",
  now: 1000,
};
const receipt = {
  version: 1,
  kind: "job-owned-postgres",
  containerName: "eliza-cloud-test-postgres",
  containerId: "a".repeat(64),
  databaseUrl: expected.databaseUrl,
  runId: "123",
  job: "e2e-tests",
  attempt: "1",
  createdAt: 900,
};
test("exact owned PostgreSQL receipt accepted", () =>
  assert.equal(validateStrictFixtureAuthority(receipt, expected), receipt));
for (const [name, delta] of Object.entries({
  remote: { databaseUrl: "postgresql://prod.example/postgres" },
  job: { job: "other" },
  run: { runId: "other" },
  attempt: { attempt: "2" },
  stale: { createdAt: -4000000 },
  future: { createdAt: 2000 },
  container: { containerId: "not-an-id" },
}))
  test(`rejects ${name} mismatch`, () =>
    assert.throws(() =>
      validateStrictFixtureAuthority({ ...receipt, ...delta }, expected),
    ));
