/** Reuse the exact-name JUnit supervisor for real PostgreSQL capacity checks. */
import { runContainerConformance as runPostgresConformance } from "./container-conformance.mjs";

await runPostgresConformance(
  "quint-job-shared-capacity",
  [
    {
      file: "packages/cloud/shared/src/db/repositories/job-shared-capacity.postgres.integration.test.ts",
      names: [
        "concurrent cross-type claims share the last global capacity slot",
        "foreign tenant occupancy counts while due tenant candidates keep their order",
        "a locked first row is skipped without blocking the next due claim",
        "failed lease installation rolls back both admission and capacity consumption",
        "historical overfull occupancy admits no additional job",
        "postcommit hydration failure retains the exact durable capacity claim",
        "queue eligibility uses current database time after an advisory lock wait",
        "invalid shared capacity inputs return empty without changing the queue",
      ],
    },
  ],
  true,
);
