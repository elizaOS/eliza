#!/usr/bin/env node
/**
 * cloud-e2e.mjs
 *
 * End-to-end smoke driver for the Eliza Cloud agent lifecycle. Hits the
 * production cloud REST API (api.elizacloud.ai) directly with Bearer auth —
 * no UI, no runtime, no plugin code. Exercises:
 *
 *   1. GET  /api/v1/user                          (whoami)
 *   2. GET  /api/v1/credits/balance               (sanity)
 *   3. GET  /api/v1/eliza/agents                  (list-existing)
 *   4. POST /api/v1/eliza/agents                  (create)
 *   5. POST /api/v1/eliza/agents/:id/provision    (provision)
 *   6. GET  /api/v1/jobs/:jobId                   (poll until completed)
 *   7. POST /api/v1/eliza/agents/:id/pairing-token (connect handshake)
 *   8. DELETE /api/v1/eliza/agents/:id            (cleanup, unless --keep)
 *
 * Endpoint shapes confirmed against:
 *   - cloud-pr484/apps/api/v1/eliza/agents/...
 *   - packages/ui/src/api/client-cloud-direct-auth.test.ts
 *
 * Usage:
 *   ELIZAOS_CLOUD_API_KEY=eliza_... node scripts/cloud-e2e.mjs
 *   ELIZAOS_CLOUD_API_KEY=... node scripts/cloud-e2e.mjs --keep --name "Test Agent"
 *   ELIZAOS_CLOUD_API_KEY=... node scripts/cloud-e2e.mjs --skip-provision  # list only
 *
 * Exit code: 0 on success, 1 on any step failure. Prints a step-by-step
 * trace of what worked / what didn't so it's obvious where the cloud
 * connection mode breaks.
 */

const DEFAULT_API_BASE = "https://api.elizacloud.ai";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 180_000; // 3 min — provisioning can be slow

function parseArgs(argv) {
  const args = {
    apiBase: process.env.ELIZAOS_CLOUD_API_BASE ?? DEFAULT_API_BASE,
    name: `cloud-e2e-${Date.now()}`,
    keep: false,
    skipProvision: false,
    skipDelete: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-base") args.apiBase = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--keep") {
      args.keep = true;
      args.skipDelete = true;
    } else if (a === "--skip-provision") args.skipProvision = true;
    else if (a === "--skip-delete") args.skipDelete = true;
    else if (a === "--help" || a === "-h") {
      console.error(
        "Usage: ELIZAOS_CLOUD_API_KEY=... node scripts/cloud-e2e.mjs [--api-base URL] [--name NAME] [--keep] [--skip-provision] [--skip-delete]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

class Reporter {
  constructor() {
    this.steps = [];
  }
  start(name) {
    const startedAt = Date.now();
    process.stderr.write(`▶ ${name}... `);
    return (status, detail) => {
      const ms = Date.now() - startedAt;
      this.steps.push({ name, status, detail, ms });
      const symbol = status === "ok" ? "✓" : status === "skip" ? "—" : "✗";
      process.stderr.write(
        `${symbol} (${ms}ms)${detail ? ` ${detail}` : ""}\n`,
      );
    };
  }
  summary() {
    const ok = this.steps.filter((s) => s.status === "ok").length;
    const skip = this.steps.filter((s) => s.status === "skip").length;
    const fail = this.steps.filter((s) => s.status === "fail").length;
    process.stderr.write(
      `\n══ ${ok} ok · ${skip} skipped · ${fail} failed ══\n`,
    );
    return fail === 0;
  }
}

async function bearerFetch(apiBase, path, opts = {}) {
  const apiKey = process.env.ELIZAOS_CLOUD_API_KEY;
  if (!apiKey) throw new Error("ELIZAOS_CLOUD_API_KEY is required");
  const url = `${apiBase.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { _raw: text };
  }
  return { status: res.status, ok: res.ok, body };
}

function shortId(id) {
  if (typeof id !== "string") return String(id);
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

async function whoami(apiBase, report) {
  const done = report.start("GET /api/v1/user");
  const r = await bearerFetch(apiBase, "/api/v1/user");
  if (!r.ok) {
    done("fail", `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    throw new Error(`whoami failed (${r.status}) — token invalid?`);
  }
  const user = r.body?.data ?? r.body;
  const userId = user?.id ?? user?.user_id;
  const orgId = user?.organization_id ?? user?.organizationId;
  done("ok", `user=${shortId(userId ?? "?")} org=${shortId(orgId ?? "?")}`);
  return { userId, orgId };
}

async function credits(apiBase, report) {
  const done = report.start("GET /api/v1/credits/balance");
  const r = await bearerFetch(apiBase, "/api/v1/credits/balance");
  if (!r.ok) {
    done("fail", `HTTP ${r.status}`);
    return null;
  }
  const balance = r.body?.balance ?? r.body?.data?.balance ?? null;
  done("ok", `balance=${balance ?? "n/a"}`);
  return balance;
}

async function listAgents(apiBase, report) {
  const done = report.start("GET /api/v1/eliza/agents");
  const r = await bearerFetch(apiBase, "/api/v1/eliza/agents");
  if (!r.ok) {
    done("fail", `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    throw new Error("list agents failed");
  }
  const data = r.body?.data ?? [];
  const agents = Array.isArray(data) ? data : [];
  done("ok", `${agents.length} agents`);
  return agents;
}

async function createAgent(apiBase, report, name) {
  const done = report.start(`POST /api/v1/eliza/agents (create "${name}")`);
  const r = await bearerFetch(apiBase, "/api/v1/eliza/agents", {
    method: "POST",
    body: JSON.stringify({
      agentName: name,
      agentConfig: {
        bio: ["End-to-end smoke test agent created by scripts/cloud-e2e.mjs."],
      },
    }),
  });
  if (!r.ok) {
    done("fail", `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    throw new Error("create agent failed");
  }
  const agent = r.body?.data ?? r.body;
  const id = agent?.id ?? agent?.agentId ?? agent?.agent_id;
  if (!id)
    throw new Error(`create returned no agent id: ${JSON.stringify(r.body)}`);
  done("ok", `agent=${shortId(id)} status=${agent?.status ?? "?"}`);
  return id;
}

async function provisionAgent(apiBase, report, agentId) {
  const done = report.start(
    `POST /api/v1/eliza/agents/${shortId(agentId)}/provision`,
  );
  const r = await bearerFetch(
    apiBase,
    `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/provision`,
    { method: "POST", body: JSON.stringify({}) },
  );
  // 409 with alreadyInProgress is success per the existing client.
  if (!r.ok && r.status !== 409) {
    done("fail", `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    throw new Error("provision failed");
  }
  const data = r.body?.data ?? r.body;
  const jobId = data?.jobId ?? data?.job_id ?? r.body?.job_id;
  if (!jobId) {
    done(
      "fail",
      `no jobId in response: ${JSON.stringify(r.body).slice(0, 200)}`,
    );
    throw new Error("provision returned no jobId");
  }
  done("ok", `job=${shortId(jobId)} status=${data?.status ?? "queued"}`);
  return jobId;
}

async function pollJob(apiBase, report, jobId) {
  const done = report.start(`GET /api/v1/jobs/${shortId(jobId)} (poll)`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const r = await bearerFetch(
      apiBase,
      `/api/v1/jobs/${encodeURIComponent(jobId)}`,
    );
    if (!r.ok) {
      done("fail", `HTTP ${r.status}`);
      throw new Error(`job poll HTTP ${r.status}`);
    }
    const data = r.body?.data ?? r.body;
    last = data;
    const status = data?.status ?? data?.state;
    if (status === "completed" || status === "succeeded") {
      done(
        "ok",
        `completed in ${Math.round((Date.now() - (deadline - POLL_TIMEOUT_MS)) / 1000)}s`,
      );
      return data;
    }
    if (status === "failed" || status === "errored") {
      done("fail", `job ${status}: ${JSON.stringify(data).slice(0, 200)}`);
      throw new Error(`job ${status}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  done(
    "fail",
    `timed out after ${POLL_TIMEOUT_MS / 1000}s — last status=${last?.status}`,
  );
  throw new Error("provision job timed out");
}

async function pairingToken(apiBase, report, agentId) {
  const done = report.start(
    `POST /api/v1/eliza/agents/${shortId(agentId)}/pairing-token`,
  );
  const r = await bearerFetch(
    apiBase,
    `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/pairing-token`,
    { method: "POST", body: JSON.stringify({}) },
  );
  if (!r.ok) {
    done("fail", `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return null;
  }
  const data = r.body?.data ?? r.body;
  const token = data?.token;
  done(
    "ok",
    `token=${token ? shortId(token) : "?"} expiresIn=${data?.expiresIn ?? "?"}`,
  );
  return data;
}

async function deleteAgent(apiBase, report, agentId) {
  const done = report.start(`DELETE /api/v1/eliza/agents/${shortId(agentId)}`);
  const r = await bearerFetch(
    apiBase,
    `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`,
    { method: "DELETE" },
  );
  if (!r.ok) {
    done("fail", `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return false;
  }
  done("ok", "deleted");
  return true;
}

async function main() {
  const args = parseArgs(process.argv);
  const report = new Reporter();
  process.stderr.write(`Eliza Cloud E2E smoke against ${args.apiBase}\n`);

  let createdId = null;
  try {
    await whoami(args.apiBase, report);
    await credits(args.apiBase, report);
    await listAgents(args.apiBase, report);

    if (args.skipProvision) {
      process.stderr.write("(--skip-provision: stopping after list)\n");
      return report.summary() ? 0 : 1;
    }

    createdId = await createAgent(args.apiBase, report, args.name);
    const jobId = await provisionAgent(args.apiBase, report, createdId);
    await pollJob(args.apiBase, report, jobId);
    await pairingToken(args.apiBase, report, createdId);

    // Verify list now contains the new agent.
    const after = await listAgents(args.apiBase, report);
    const found = after.some(
      (a) => (a?.id ?? a?.agentId ?? a?.agent_id) === createdId,
    );
    const done = report.start("verify created agent appears in list");
    if (found) done("ok");
    else done("fail", "created agent missing from list response");
  } catch (err) {
    process.stderr.write(
      `\nerror: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  } finally {
    if (createdId && !args.skipDelete) {
      try {
        await deleteAgent(args.apiBase, report, createdId);
      } catch (delErr) {
        process.stderr.write(
          `cleanup failed (agent ${createdId} may need manual delete): ${delErr instanceof Error ? delErr.message : String(delErr)}\n`,
        );
      }
    } else if (createdId && args.skipDelete) {
      process.stderr.write(
        `(--keep / --skip-delete: agent ${createdId} preserved on cloud)\n`,
      );
    }
  }

  process.exit(report.summary() ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
