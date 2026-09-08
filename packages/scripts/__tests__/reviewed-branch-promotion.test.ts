/** Exercises promotion requests at the GitHub transport boundary, including stale commits and fork collisions. */
import { expect, test } from "bun:test";
import {
  requestReviewedPromotion,
  verifyMergedPromotion,
} from "../reviewed-branch-promotion.mjs";

const sourceSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const input = {
  sourceBranch: "develop",
  targetBranch: "staging",
  sourceSha,
  sourceRunUrl: "https://github.com/example/repo/actions/runs/42",
};

test("requires the destination merge to preserve the reviewed source tree", async () => {
  const targetSha = "d".repeat(40);
  let targetTree = treeSha;
  const api = {
    request: async (_method: string, endpoint: string) => {
      if (endpoint.includes("/pulls?"))
        return [
          {
            merged_at: "2026-09-06T00:00:00Z",
            merge_commit_sha: targetSha,
            base: { ref: "main", repo: { id: 1 } },
            head: { ref: "staging", sha: sourceSha, repo: { id: 1 } },
          },
        ];
      if (endpoint === `/git/commits/${sourceSha}`)
        return { tree: { sha: treeSha } };
      if (endpoint === `/git/commits/${targetSha}`)
        return { tree: { sha: targetTree } };
      throw new Error(`unexpected request ${endpoint}`);
    },
  };
  expect(await verifyMergedPromotion(api, "main", targetSha)).toMatchObject({
    sourceBranch: "staging",
    sourceSha,
  });
  targetTree = "e".repeat(40);
  await expect(verifyMergedPromotion(api, "main", targetSha)).rejects.toThrow(
    "tree differs",
  );
});

test("a direct destination push cannot claim reviewed promotion authority", async () => {
  const api = { request: async () => [] };
  await expect(
    verifyMergedPromotion(api, "staging", "d".repeat(40)),
  ).rejects.toThrow("merged develop -> staging PR");
});

test("retrying after a reviewed merge recognizes completion without creating another PR", async () => {
  const mergeSha = "d".repeat(40);
  let merged = false;
  let writes = 0;
  const historyPages: string[] = [];
  const api = {
    request: async (method: string, endpoint: string) => {
      if (method === "POST" && endpoint === "/pulls") {
        writes++;
        return {
          number: 7,
          html_url: "https://github.com/example/repo/pull/7",
        };
      }
      if (method !== "GET") throw new Error("unexpected mutation");
      if (endpoint === "") return { owner: { login: "example" } };
      if (endpoint === "/git/ref/heads/develop")
        return { object: { sha: sourceSha } };
      if (endpoint === "/git/ref/heads/staging")
        return { object: { sha: mergeSha } };
      if (endpoint.startsWith("/git/commits/"))
        return { tree: { sha: treeSha } };
      if (endpoint.startsWith("/compare/")) return { status: "identical" };
      if (endpoint.includes("state=closed")) {
        if (!endpoint.includes("base=staging&head=example%3Adevelop"))
          throw new Error("history must select the canonical promotion pair");
        historyPages.push(endpoint);
        if (merged && endpoint.endsWith("page=1"))
          return Array.from({ length: 100 }, () => ({ merged_at: null }));
        return merged
          ? [
              {
                number: 7,
                merged_at: "2026-09-06T00:00:00Z",
                merge_commit_sha: mergeSha,
                head: { ref: "develop", sha: sourceSha, repo: { id: 1 } },
                base: { ref: "staging", repo: { id: 1 } },
              },
            ]
          : [];
      }
      if (endpoint.startsWith("/pulls?")) return [];
      throw new Error(`unexpected request ${endpoint}`);
    },
  };
  expect((await requestReviewedPromotion(api, input)).action).toBe(
    "awaiting-review",
  );
  merged = true;
  expect((await requestReviewedPromotion(api, input)).action).toBe(
    "already-promoted",
  );
  expect(writes).toBe(1);
  expect(historyPages.some((endpoint) => endpoint.endsWith("page=2"))).toBe(
    true,
  );
});

function harness({ stale = false, fork = false } = {}) {
  const writes: Array<{
    method: string;
    endpoint: string;
    body: Record<string, string>;
  }> = [];
  let refReads = 0;
  const api = {
    async request(
      method: string,
      endpoint: string,
      body?: Record<string, string>,
    ) {
      if (method !== "GET") {
        if (!body) throw new Error("missing write body");
        writes.push({ method, endpoint, body });
        return {
          number: 7,
          html_url: "https://github.com/example/repo/pull/7",
        };
      }
      if (endpoint === "") return { owner: { login: "example" } };
      if (endpoint.includes("/git/ref/")) {
        refReads++;
        return {
          object: { sha: stale && refReads > 1 ? "c".repeat(40) : sourceSha },
        };
      }
      if (endpoint.includes("/git/commits/")) return { tree: { sha: treeSha } };
      if (endpoint.includes("state=closed")) return [];
      if (endpoint.startsWith("/pulls?"))
        return fork
          ? [
              {
                number: 3,
                head: { ref: "develop", sha: sourceSha, repo: { id: 2 } },
                base: { repo: { id: 1 } },
              },
            ]
          : [];
      throw new Error(`unexpected request ${endpoint}`);
    },
  };
  return { api, writes };
}

test("creates a review request bound to validated source without writing refs or merging", async () => {
  const { api, writes } = harness();
  expect(await requestReviewedPromotion(api, input)).toMatchObject({
    action: "awaiting-review",
    sourceSha,
    treeSha,
  });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    method: "POST",
    endpoint: "/pulls",
    body: { head: "develop", base: "staging" },
  });
  expect(writes[0].body.body).toContain(sourceSha);
  expect(writes[0].body.body).toContain(treeSha);
});

test("source movement before the write prevents a stale promotion request", async () => {
  const { api, writes } = harness({ stale: true });
  expect(await requestReviewedPromotion(api, input)).toEqual({
    action: "stale",
  });
  expect(writes).toEqual([]);
});

test("a fork branch with the same name cannot be updated as the canonical promotion", async () => {
  const { api, writes } = harness({ fork: true });
  await requestReviewedPromotion(api, input);
  expect(writes[0].endpoint).toBe("/pulls");
  expect(writes[0].method).toBe("POST");
});

test("rejects a develop to main shortcut before contacting GitHub", async () => {
  const api = {
    request: async () => {
      throw new Error("must not contact GitHub");
    },
  };
  await expect(
    requestReviewedPromotion(api, { ...input, targetBranch: "main" }),
  ).rejects.toThrow("develop -> staging -> main");
});
