/** Promotion admission against legacy and 2026 REST PR responses. */
import { expect, test } from "bun:test";
import {
  requestReviewedPromotion,
  verifyMergedPromotion,
} from "../reviewed-branch-promotion.ts";

const SOURCE = "a".repeat(40),
  TARGET = "b".repeat(40),
  TREE = "c".repeat(40);
function fixture({
  legacy = false,
  merge = TARGET,
  tree = TREE,
  merged = true,
  foreign = false,
} = {}) {
  const pr = {
    number: 42,
    node_id: "PR_fixture",
    merged_at: "2026-10-05T00:00:00Z",
    ...(legacy ? { merge_commit_sha: TARGET } : {}),
    head: { ref: "develop", sha: SOURCE, repo: { id: foreign ? 2 : 1 } },
    base: { ref: "staging", repo: { id: 1 } },
  };
  let graphCalls = 0;
  return {
    get graphCalls() {
      return graphCalls;
    },
    async graphql(_query, variables) {
      expect(variables).toEqual({ id: pr.node_id });
      graphCalls++;
      return { node: { id: pr.node_id, merged, mergeCommit: { oid: merge } } };
    },
    async request(method, path) {
      expect(method).toBe("GET");
      if (
        path.startsWith(`/commits/${TARGET}/pulls`) ||
        path.startsWith("/pulls?state=closed")
      )
        return [pr];
      if (path === `/git/commits/${SOURCE}`) return { tree: { sha: TREE } };
      if (path === `/git/commits/${TARGET}`) return { tree: { sha: tree } };
      if (path === "/git/ref/heads/develop") return { object: { sha: SOURCE } };
      if (path === "/git/ref/heads/staging") return { object: { sha: TARGET } };
      if (path === "") return { owner: { login: "owner" } };
      if (path === `/compare/${TARGET}...${TARGET}`)
        return { status: "identical" };
      throw new Error(`Unexpected ${path}`);
    },
  };
}
test("2026 REST omission uses the immutable merged PR node", async () => {
  const api = fixture();
  expect(await verifyMergedPromotion(api, "staging", TARGET)).toEqual({
    sourceBranch: "develop",
    sourceSha: SOURCE,
    treeSha: TREE,
  });
  expect(api.graphCalls).toBe(1);
});
test("legacy responses retain exact admission without GraphQL", async () => {
  const api = fixture({ legacy: true });
  await verifyMergedPromotion(api, "staging", TARGET);
  expect(api.graphCalls).toBe(0);
});
test("modern history recognizes completed promotions without creating another PR", async () => {
  const api = fixture();
  expect(
    (
      await requestReviewedPromotion(api, {
        sourceBranch: "develop",
        targetBranch: "staging",
        sourceSha: SOURCE,
        sourceRunUrl: "https://example.invalid/run",
      })
    ).action,
  ).toBe("already-promoted");
});
test("missing, wrong, unmerged, foreign and changed-tree proofs stay rejected", async () => {
  for (const options of [
    { merge: "" },
    { merge: SOURCE },
    { merged: false },
    { foreign: true },
    { tree: SOURCE },
  ]) {
    await expect(
      verifyMergedPromotion(fixture(options), "staging", TARGET),
    ).rejects.toThrow();
  }
});
