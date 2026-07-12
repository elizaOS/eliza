import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { mkdtempInTestRoot } from "./helpers/tmp-root.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = new URL("../../..", import.meta.url);
const PILOT_BOOTSTRAP_PATH = new URL(
  "deployment/hetzner-staging/scripts/pilot-bootstrap.mjs",
  REPO_ROOT,
);
const PILOT_BOOTSTRAP_DOC_PATH = new URL(
  "deployment/hetzner-staging/pilot-bootstrap.md",
  REPO_ROOT,
);
const RELEASE_GATE_PATH = new URL(
  "deployment/hetzner-staging/scripts/release-gate.sh",
  REPO_ROOT,
);

describe("private pilot bootstrap script", () => {
  it("plans the private pilot bootstrap without network or secret-bearing evidence", async () => {
    const result = await runPilotBootstrap({
      env: {
        FORGEJO_ROOT_URL: "https://git.example.invalid/",
        MERGE_STEWARD_URL: "https://git.example.invalid/steward/",
        ELIZA_REQUIRED_CHECKS: JSON.stringify([
          "runner-smoke / smoke",
          "merge-steward / gate",
        ]),
        ELIZA_TRUSTED_AGENT_IDS: JSON.stringify(["agent-codex", "agent-docs"]),
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /dry-run complete/);

    const evidenceText = await readFile(result.output, "utf8");
    const evidence = JSON.parse(evidenceText);
    assert.equal(evidence.dryRun, true);
    assert.equal(evidence.repo.fullName, "elizaos/eliza");
    assert.equal(evidence.upstream.host, "github.com");
    assert.equal(evidence.migration.direction, "pull");
    assert.equal(evidence.migration.mirror, true);
    assert.equal(evidence.migration.private, true);
    assert.equal(evidence.summary.productionReady, false);
    assert.equal(evidence.summary.stepCount, 8);
    assert.equal(evidence.summary.requiredCheckCount, 2);
    assert.equal(evidence.summary.trustedAgentCount, 2);
    assert.deepEqual(stepNames(evidence), [
      "forgejo-api-schema",
      "mirror-repository",
      "verify-default-branch",
      "steward-webhook",
      "branch-protection",
      "repo-policy",
      "agent-identities",
      "pilot-surfaces",
    ]);
    assert.doesNotMatch(
      evidenceText,
      /bootstrap-token|webhook-secret|steward-token/,
    );
  });

  it("creates missing mirror, webhook, branch protection, repo policy, and agent identities", async () => {
    await withPilotServers(async ({ forgejo, steward }) => {
      const result = await runPilotBootstrap({
        args: ["--apply"],
        env: pilotEnv(forgejo.url, steward.url),
      });

      assert.equal(result.code, 0, result.stderr);

      const evidenceText = await readFile(result.output, "utf8");
      const evidence = JSON.parse(evidenceText);
      assert.equal(evidence.dryRun, false);
      assert.equal(evidence.summary.productionReady, true);
      assert.equal(evidence.summary.stepCount, 9);
      assert.equal(evidence.summary.mirrorVerified, true);
      assert.equal(evidence.summary.defaultBranchVerified, true);
      assert.equal(evidence.summary.webhookVerified, true);
      assert.equal(evidence.summary.branchProtectionVerified, true);
      assert.equal(evidence.summary.repoPolicyVerified, true);
      assert.equal(evidence.summary.agentIdentitiesSynced, true);
      assert.equal(evidence.summary.pilotSurfacesVerified, true);
      assert.equal(evidence.summary.pullMirrorOnly, true);
      assert.equal(step(evidence, "mirror-repository").status, "created");
      assert.equal(step(evidence, "steward-webhook").status, "created");
      assert.equal(step(evidence, "branch-protection").status, "created");
      assert.equal(step(evidence, "repo-policy").status, "upserted");
      assert.equal(step(evidence, "agent-identities").status, "synced");
      assert.equal(step(evidence, "pilot-surfaces").status, "verified");
      assert.doesNotMatch(evidenceText, /webhook-secret/);
      assert.doesNotMatch(evidenceText, /bootstrap-token/);
      assert.doesNotMatch(evidenceText, /steward-token/);

      assert.ok(
        forgejo.requests.some(
          (request) =>
            request.method === "POST" &&
            request.url.pathname === "/api/v1/repos/migrate",
        ),
      );
      assert.ok(
        forgejo.requests.some(
          (request) =>
            request.method === "POST" &&
            request.url.pathname.endsWith("/hooks"),
        ),
      );
      assert.ok(
        forgejo.requests.some(
          (request) =>
            request.method === "POST" &&
            request.url.pathname.endsWith("/branch_protections"),
        ),
      );
      assert.ok(
        steward.requests.some(
          (request) =>
            request.method === "POST" &&
            request.url.pathname === "/api/repo-policies",
        ),
      );
      assert.equal(
        steward.requests.filter(
          (request) =>
            request.method === "POST" &&
            request.url.pathname === "/api/agent-identities",
        ).length,
        2,
      );
      assert.deepEqual(steward.state.policy.requiredChecks, [
        "runner-smoke / smoke",
        "merge-steward / gate",
      ]);
      assert.deepEqual([...steward.state.agents.keys()].sort(), [
        "agent-codex",
        "agent-docs",
      ]);
      assert.equal(forgejo.state.webhooks[0].config.secret, "webhook-secret");
    });
  });

  it("verifies existing resources without recreating Forgejo state", async () => {
    const initialForgejoState = {
      repoExists: true,
      webhooks: [
        {
          id: 7,
          type: "forgejo",
          active: true,
          events: ["push", "pull_request"],
          config: {
            url: null,
          },
        },
      ],
      branchProtections: [
        {
          rule_name: "main",
          enable_status_check: true,
          status_check_contexts: [
            "runner-smoke / smoke",
            "merge-steward / gate",
          ],
          required_approvals: 1,
          apply_to_admins: true,
        },
      ],
    };

    await withPilotServers(
      async ({ forgejo, steward }) => {
        forgejo.state.webhooks[0].config.url = new URL(
          "api/webhooks/forgejo",
          steward.url,
        ).toString();

        const result = await runPilotBootstrap({
          args: ["--apply"],
          env: pilotEnv(forgejo.url, steward.url),
        });

        assert.equal(result.code, 0, result.stderr);

        const evidence = JSON.parse(await readFile(result.output, "utf8"));
        assert.equal(
          step(evidence, "mirror-repository").status,
          "verified-existing",
        );
        assert.equal(
          step(evidence, "steward-webhook").status,
          "verified-existing",
        );
        assert.equal(
          step(evidence, "branch-protection").status,
          "verified-existing",
        );
        assert.equal(
          forgejo.requests.filter(
            (request) =>
              request.method === "POST" &&
              request.url.pathname === "/api/v1/repos/migrate",
          ).length,
          0,
        );
        assert.equal(
          forgejo.requests.filter(
            (request) =>
              request.method === "POST" &&
              request.url.pathname.endsWith("/hooks"),
          ).length,
          0,
        );
        assert.equal(
          forgejo.requests.filter(
            (request) =>
              request.method === "POST" &&
              request.url.pathname.endsWith("/branch_protections"),
          ).length,
          0,
        );
        assert.equal(
          forgejo.requests.filter((request) => request.method === "PATCH")
            .length,
          0,
        );
      },
      { forgejoState: initialForgejoState },
    );
  });

  it("wires the script into release checks and operator docs", async () => {
    const gate = await readFile(RELEASE_GATE_PATH, "utf8");
    const doc = await readFile(PILOT_BOOTSTRAP_DOC_PATH, "utf8");

    assert.match(gate, /pilot-bootstrap\.mjs/);
    assert.match(
      gate,
      /node --check "\$DEPLOY_DIR\/scripts\/pilot-bootstrap\.mjs"/,
    );
    assert.match(doc, /scripts\/pilot-bootstrap\.mjs/);
    assert.match(doc, /PILOT_BOOTSTRAP_DRY_RUN=true/);
    assert.match(doc, /PILOT_BOOTSTRAP_EVIDENCE_OUT/);
  });
});

async function runPilotBootstrap({ args = [], env = {} } = {}) {
  const dir = await mkdtempInTestRoot("pilot-bootstrap-");
  const envFile = path.join(dir, ".env");
  const output = path.join(dir, "pilot-bootstrap-evidence.json");
  await mkdir(dir, { recursive: true });
  await writeFile(envFile, envFileBody(env), "utf8");
  await chmod(PILOT_BOOTSTRAP_PATH, 0o755);

  try {
    const result = await execFileAsync(
      process.execPath,
      [
        PILOT_BOOTSTRAP_PATH.pathname,
        "--env-file",
        envFile,
        "--output",
        output,
        ...args,
      ],
      {
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr, output };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      output,
    };
  }
}

function pilotEnv(forgejoUrl, stewardUrl) {
  return {
    FORGEJO_ROOT_URL: forgejoUrl,
    MERGE_STEWARD_URL: stewardUrl,
    FORGEJO_BOOTSTRAP_TOKEN: "bootstrap-token",
    FORGEJO_WEBHOOK_SECRET: "webhook-secret",
    MERGE_STEWARD_CONTROL_TOKEN: "steward-token",
    ELIZA_REQUIRED_CHECKS: JSON.stringify([
      "runner-smoke / smoke",
      "merge-steward / gate",
    ]),
    ELIZA_TRUSTED_AGENT_IDS: JSON.stringify(["agent-codex", "agent-docs"]),
  };
}

function envFileBody(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}='${String(value).replaceAll("'", "'\\''")}'`)
    .join("\n")}\n`;
}

async function withPilotServers(callback, { forgejoState = {} } = {}) {
  const steward = await startStewardServer();
  const forgejo = await startForgejoServer({ ...forgejoState });

  try {
    await callback({ forgejo, steward });
  } finally {
    await Promise.all([forgejo.close(), steward.close()]);
  }
}

async function startForgejoServer(initialState = {}) {
  const state = {
    repoExists: false,
    webhooks: [],
    branchProtections: [],
    ...initialState,
  };
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const body = await readRequestJson(request);
    requests.push({
      method: request.method,
      url,
      body,
      authorization: request.headers.authorization,
    });

    if (request.method === "GET" && url.pathname === "/swagger.v1.json") {
      return sendJson(response, 200, { swagger: "2.0" });
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/repos/elizaos/eliza"
    ) {
      return state.repoExists
        ? sendJson(response, 200, {
            full_name: "elizaos/eliza",
            mirror: true,
            private: true,
          })
        : sendJson(response, 404, { error: "not_found" });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/repos/migrate") {
      state.repoExists = true;
      return sendJson(response, 201, {
        full_name: "elizaos/eliza",
        mirror: true,
        private: true,
      });
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/repos/elizaos/eliza/branches/main"
    ) {
      return state.repoExists
        ? sendJson(response, 200, { name: "main" })
        : sendJson(response, 404, { error: "not_found" });
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/repos/elizaos/eliza/hooks"
    ) {
      return sendJson(response, 200, state.webhooks);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/repos/elizaos/eliza/hooks"
    ) {
      const hook = { id: state.webhooks.length + 1, ...body };
      state.webhooks.push(hook);
      return sendJson(response, 201, hook);
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/repos/elizaos/eliza/branch_protections"
    ) {
      return sendJson(response, 200, state.branchProtections);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/repos/elizaos/eliza/branch_protections"
    ) {
      state.branchProtections.push(body);
      return sendJson(response, 201, body);
    }

    if (
      request.method === "PATCH" &&
      url.pathname === "/api/v1/repos/elizaos/eliza/branch_protections/main"
    ) {
      state.branchProtections = [body];
      return sendJson(response, 200, body);
    }

    return sendJson(response, 404, {
      error: "unexpected_forgejo_route",
      path: url.pathname,
    });
  });

  return listen(server, { state, requests });
}

async function startStewardServer() {
  const state = {
    policy: null,
    agents: new Map(),
  };
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const body = await readRequestJson(request);
    requests.push({
      method: request.method,
      url,
      body,
      authorization: request.headers.authorization,
    });

    if (request.method === "POST" && url.pathname === "/api/repo-policies") {
      state.policy = body.policy ?? body;
      return sendJson(response, 200, { policy: state.policy });
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/repo-policies/item"
    ) {
      return state.policy
        ? sendJson(response, 200, { policy: state.policy })
        : sendJson(response, 404, { error: "repo_policy_not_found" });
    }

    if (request.method === "POST" && url.pathname === "/api/agent-identities") {
      const agent = {
        ...(body.agent ?? body),
        status: body.agent?.status ?? body.status ?? "active",
      };
      state.agents.set(agent.id, agent);
      return sendJson(response, 200, {
        agent,
        summary: { active: state.agents.size },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/agent-identities") {
      return sendJson(response, 200, {
        agents: [...state.agents.values()],
        summary: { active: state.agents.size },
      });
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/repository-protection"
    ) {
      return sendJson(response, 200, {
        repositoryProtection: { productionReady: true },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/project-board") {
      return sendJson(response, 200, {
        board: { repo: url.searchParams.get("repo") },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/work-dashboard") {
      return sendJson(response, 200, {
        workDashboard: { repo: url.searchParams.get("repo") },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/merge-queue") {
      return sendJson(response, 200, {
        mergeQueue: { repo: url.searchParams.get("repo") },
      });
    }

    return sendJson(response, 404, {
      error: "unexpected_steward_route",
      path: url.pathname,
    });
  });

  return listen(server, { state, requests });
}

function listen(server, extra) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        ...extra,
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) =>
              error ? closeReject(error) : closeResolve(),
            );
          }),
      });
    });
  });
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

function stepNames(evidence) {
  return evidence.steps.map((candidate) => candidate.name);
}

function step(evidence, name) {
  const found = evidence.steps.find((candidate) => candidate.name === name);
  assert.ok(found, `missing step ${name}`);
  return found;
}
