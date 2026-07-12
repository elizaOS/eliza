import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ForgejoClient } from "../src/forgejo-client.js";

describe("ForgejoClient", () => {
  it("builds branch protection API requests", async () => {
    const calls = [];
    const client = new ForgejoClient({
      baseUrl: "https://git.example.invalid/",
      token: "forgejo-token",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse([]);
      },
    });

    await client.listBranchProtections(
      { owner: "elizaos", repo: "eliza" },
      { page: 2 },
    );
    await client.getBranchProtection(
      { owner: "elizaos", repo: "eliza" },
      "release/**",
    );
    await client.getBranch({ owner: "elizaos", repo: "eliza" }, "develop");

    assert.deepEqual(
      calls.map(
        (call) => `${call.init.method} ${call.url.pathname}${call.url.search}`,
      ),
      [
        "GET /api/v1/repos/elizaos/eliza/branch_protections?page=2",
        "GET /api/v1/repos/elizaos/eliza/branch_protections/release%2F**",
        "GET /api/v1/repos/elizaos/eliza/branches/develop",
      ],
    );
    assert.equal(calls[0].init.headers.Authorization, "token forgejo-token");
  });

  it("builds Actions workflow run API requests", async () => {
    const calls = [];
    const client = new ForgejoClient({
      baseUrl: "https://git.example.invalid/",
      token: "forgejo-token",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({});
      },
    });

    await client.listWorkflowRuns(
      { owner: "elizaos", repo: "eliza" },
      { limit: 5 },
    );
    await client.getWorkflowRun({ owner: "elizaos", repo: "eliza" }, 42);

    assert.deepEqual(
      calls.map(
        (call) => `${call.init.method} ${call.url.pathname}${call.url.search}`,
      ),
      [
        "GET /api/v1/repos/elizaos/eliza/actions/runs?limit=5",
        "GET /api/v1/repos/elizaos/eliza/actions/runs/42",
      ],
    );
    assert.equal(calls[0].init.headers.Authorization, "token forgejo-token");
  });
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
