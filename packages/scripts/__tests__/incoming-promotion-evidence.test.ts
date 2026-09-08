/** Exercises destination admission against GitHub ledger and workflow responses, including incomplete staging releases and failed validation. */
import { expect, test } from "bun:test";
import {
  createLedgerPayload,
  verifyIncomingEffectProofs,
} from "../develop-effect-ledger.mjs";

const sourceSha = "a".repeat(40);
const incoming = { sourceBranch: "staging", sourceSha };
const effects = [
  { id: "apps-worker-staging", workflow: "deploy-apps-worker.yml" },
  { id: "cloud-staging", workflow: "cloud-cf-deploy.yml" },
];
const registry = { ledgerVersion: "test-v1", effects };

function github({
  missingCloud = false,
  stale = false,
  failedRun = false,
} = {}) {
  const calls: string[] = [];
  return {
    calls,
    async request(method: string, endpoint: string) {
      if (method !== "GET") throw new Error("admission must not mutate GitHub");
      calls.push(endpoint);
      if (endpoint.startsWith("/deployments?")) {
        const effect = endpoint.includes("cloud-staging")
          ? effects[1]
          : effects[0];
        if (missingCloud && effect.id === "cloud-staging") return [];
        return [
          {
            id: effect.id === "cloud-staging" ? 2 : 1,
            payload: createLedgerPayload({
              effect: effect.id,
              workflow: effect.workflow,
              ledgerVersion: "test-v1",
              sourceSha: stale ? "b".repeat(40) : sourceSha,
              sourceRunId: "42",
              inputDigest: "c".repeat(64),
            }),
          },
        ];
      }
      if (endpoint.includes("/statuses?")) return [{ state: "success" }];
      if (endpoint === "/actions/runs/42")
        return {
          id: 42,
          event: "push",
          head_branch: "staging",
          head_sha: sourceSha,
          path: ".github/workflows/develop-full.yml",
          status: "completed",
          conclusion: failedRun ? "failure" : "success",
        };
      throw new Error(`unexpected request ${endpoint}`);
    },
  };
}

test("admits destination effects only after every exact source effect and validation succeeds", async () => {
  const api = github();
  await verifyIncomingEffectProofs(api, incoming, registry);
  expect(api.calls).toContain("/deployments/2/statuses?per_page=1");
  expect(api.calls.filter((path) => path === "/actions/runs/42")).toHaveLength(
    2,
  );
});

test("a successful staging worker cannot substitute for a missing Cloud release", async () => {
  await expect(
    verifyIncomingEffectProofs(
      github({ missingCloud: true }),
      incoming,
      registry,
    ),
  ).rejects.toThrow("cloud-staging: promoted source lacks");
});

test("a successful receipt from another commit cannot authorize production", async () => {
  await expect(
    verifyIncomingEffectProofs(github({ stale: true }), incoming, registry),
  ).rejects.toThrow("lacks exact successful effect evidence");
});

test("a green effect cannot hide a failed source validation workflow", async () => {
  await expect(
    verifyIncomingEffectProofs(github({ failedRun: true }), incoming, registry),
  ).rejects.toThrow("not green");
});
