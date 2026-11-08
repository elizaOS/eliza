/** Run source conformance for the associated container model. */
import { runContainerConformance } from "./container-conformance.mjs";

await runContainerConformance(
  "quint-app-container-publication",
  [
    {
      file: "packages/cloud/shared/src/lib/services/__tests__/app-container-terminal-status.pglite.test.ts",
      names: [
        "a delete that completes inside markRunning's read/write window cannot resurrect the row",
        "the same interleave on the pre-fix statement resurrects the row to running",
        "sequential execution \u2014 one worker, one batch \u2014 is never corrupted",
        "markError cannot flip a completed delete back to failed",
        "markCleanupRequired cannot pin node capacity on a completed delete",
        "markDeleted stays idempotent and stays organization-scoped",
        "patched and pre-fix statements agree on every transition out of a non-terminal status",
        "a status update on an absent row still returns null (unchanged)",
        "org-scoped writes are untouched by the status CAS",
        "pending retirement wins against a captured app publication snapshot",
        "retirement after the atomic publication preserves its newer ownership metadata",
        "original generation and microsecond row identity fence late provider publication",
        "a superseded provision deletes only its returned Docker id and preserves retirement",
      ],
    },
    {
      file: "packages/cloud/shared/src/lib/services/__tests__/provisioning-execution-authority.pglite.test.ts",
      names: [
        "recovered worker success cannot mutate successor placement or delete by name",
        "recovered worker failure cannot mutate successor placement or delete by name",
        "expired lease fails dependent writes before any takeover",
        "job tenant, owner and generation each fence dependent publication",
        "the same worker owner cannot reuse a stale execution generation",
        "all dependent failure, release and deletion writes reject a superseded claim",
        "cancelled claim cannot publish after provider completion",
        "a live job cannot change a terminal container back to failed",
        "expired execution rejects each container provider entry point before dispatch",
        "retirement beats a live claim's delayed publication without losing its delete receipt",
        "publication rechecks the database lease clock after waiting for its resource lock",
        "an admitted dependent transaction retains its locks through lease expiry",
      ],
    },
  ],
  true,
);
