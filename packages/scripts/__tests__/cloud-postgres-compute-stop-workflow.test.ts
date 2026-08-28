/** Guards required real-PostgreSQL execution of compute-stop concurrency contracts. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const workflow = Bun.YAML.parse(
  readFileSync(new URL(".github/workflows/cloud-tests.yml", repoRoot), "utf8"),
) as {
  jobs?: Record<
    string,
    {
      steps?: Array<{
        name?: string;
        uses?: string;
        with?: Record<string, string>;
        env?: Record<string, string>;
        run?: string;
        "continue-on-error"?: boolean | string;
      }>;
    }
  >;
};

function requiredStep(name: string) {
  const step = workflow.jobs?.["e2e-tests"]?.steps?.find(
    (candidate) => candidate.name === name,
  );
  if (!step) throw new Error(`Missing e2e-tests workflow step: ${name}`);
  return step;
}

describe("cloud PostgreSQL compute-stop workflow", () => {
  test("provisions PostgreSQL before running the required concurrency suite", () => {
    const setup = workflow.jobs?.["e2e-tests"]?.steps?.find(
      (step) => step.uses === "./.github/actions/cloud-setup-test-env",
    );
    expect(setup?.with).toMatchObject({
      "setup-db": "true",
      "db-backend": "postgres",
    });

    const step = requiredStep("Run PostgreSQL compute stop concurrency tests");
    expect(step.env).toMatchObject({
      APPS_TENANT_DB_TEST_DSN: "postgresql://postgres@127.0.0.1:5432/postgres",
      COMPUTE_STOP_CONCURRENCY_REQUIRED: "1",
    });
    expect(step.run).toContain("bun test --config=/dev/null --isolate");
    expect(step.run).toContain(
      "packages/cloud/shared/src/db/repositories/__tests__/compute-stop-concurrency.integration.test.ts",
    );
    expect(step.run).not.toContain("|| true");
    expect(step["continue-on-error"]).toBeUndefined();
  });
});
