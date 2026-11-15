/** Run source conformance for the associated container model. */
import { runContainerConformance } from "./container-conformance.mjs";

await runContainerConformance(
  "quint-provisioning-execution",
  [
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
