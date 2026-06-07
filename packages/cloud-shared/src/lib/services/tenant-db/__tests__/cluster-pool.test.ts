import { describe, expect, test } from "bun:test";
import {
  type ClusterCandidate,
  ClusterPool,
  type ClusterPoolStore,
  NoClusterCapacityError,
  selectLeastLoadedCluster,
} from "../cluster-pool";

function cluster(p: Partial<ClusterCandidate> & { id: string }): ClusterCandidate {
  return {
    host: `host-${p.id}`,
    adminDsnEncrypted: `enc-${p.id}`,
    databaseCount: 0,
    maxDatabases: 10,
    isActive: true,
    ...p,
  };
}

describe("selectLeastLoadedCluster", () => {
  test("picks the active cluster with the lowest database_count", () => {
    const chosen = selectLeastLoadedCluster([
      cluster({ id: "a", databaseCount: 5 }),
      cluster({ id: "b", databaseCount: 2 }),
      cluster({ id: "c", databaseCount: 8 }),
    ]);
    expect(chosen?.id).toBe("b");
  });

  test("ties break deterministically by id", () => {
    const chosen = selectLeastLoadedCluster([
      cluster({ id: "z", databaseCount: 3 }),
      cluster({ id: "a", databaseCount: 3 }),
    ]);
    expect(chosen?.id).toBe("a");
  });

  test("skips full and inactive clusters", () => {
    expect(
      selectLeastLoadedCluster([
        cluster({ id: "full", databaseCount: 10, maxDatabases: 10 }),
        cluster({ id: "off", databaseCount: 0, isActive: false }),
      ]),
    ).toBeNull();
    expect(
      selectLeastLoadedCluster([
        cluster({ id: "full", databaseCount: 10, maxDatabases: 10 }),
        cluster({ id: "ok", databaseCount: 9, maxDatabases: 10 }),
      ])?.id,
    ).toBe("ok");
  });

  test("returns null for an empty pool", () => {
    expect(selectLeastLoadedCluster([])).toBeNull();
  });
});

describe("ClusterPool.allocate", () => {
  function store(
    candidates: ClusterCandidate[],
    claim: (id: string) => boolean,
  ): ClusterPoolStore & { claims: string[] } {
    const claims: string[] = [];
    return {
      claims,
      async listAllocatable() {
        return candidates;
      },
      async tryClaimSlot(id) {
        claims.push(id);
        return claim(id);
      },
    };
  }

  test("allocates the least-loaded cluster and returns its admin handle", async () => {
    const s = store(
      [cluster({ id: "a", databaseCount: 4 }), cluster({ id: "b", databaseCount: 1 })],
      () => true,
    );
    const got = await new ClusterPool(s).allocate();
    expect(got).toEqual({ id: "b", host: "host-b", adminDsnEncrypted: "enc-b" });
    expect(s.claims).toEqual(["b"]);
  });

  test("retries on a lost claim race, then succeeds on the next candidate", async () => {
    // 'b' is least-loaded but its claim races to full; the next read reflects
    // that (b is gone), so 'a' wins on the retry.
    const claims: string[] = [];
    let bAvailable = true;
    const s: ClusterPoolStore = {
      async listAllocatable() {
        return bAvailable
          ? [cluster({ id: "a", databaseCount: 4 }), cluster({ id: "b", databaseCount: 1 })]
          : [cluster({ id: "a", databaseCount: 4 })];
      },
      async tryClaimSlot(id) {
        claims.push(id);
        if (id === "b") {
          bAvailable = false; // raced to full
          return false;
        }
        return true;
      },
    };
    const got = await new ClusterPool(s).allocate();
    expect(got.id).toBe("a");
    expect(claims).toEqual(["b", "a"]);
  });

  test("throws NoClusterCapacityError when nothing is claimable", async () => {
    const s = store([cluster({ id: "full", databaseCount: 10, maxDatabases: 10 })], () => true);
    await expect(new ClusterPool(s).allocate()).rejects.toBeInstanceOf(NoClusterCapacityError);
  });

  test("throws after exhausting attempts when every claim keeps racing", async () => {
    const s = store([cluster({ id: "a", databaseCount: 1 })], () => false);
    await expect(new ClusterPool(s, { maxAttempts: 3 }).allocate()).rejects.toBeInstanceOf(
      NoClusterCapacityError,
    );
    expect(s.claims).toEqual(["a", "a", "a"]);
  });
});
