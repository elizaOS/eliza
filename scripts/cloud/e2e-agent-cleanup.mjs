#!/usr/bin/env bun
/**
 * Cleanup lane for cloud agents leaked by the device cloud-onboarding e2e
 * harnesses (issue #14358): every red iOS/Android run can strand another
 * billable dedicated-always agent on the shared e2e SIWE wallet's org, so
 * repeated runs drain credits and stop looking like a first run.
 *
 * Signs in headlessly with the same deterministic e2e wallet the onboarding
 * lanes use (real EIP-4361 handshake — no mock), lists the org's agents, and
 * deletes the leaked ones. Dry-run by default; --apply performs deletions.
 * DELETE either completes synchronously (shared runtime) or returns a 202
 * job which --wait polls to completion.
 *
 * Usage:
 *   bun run cloud:e2e:agents:cleanup                    # dry run vs https://api.eliza.app
 *   bun run cloud:e2e:agents:cleanup -- --apply --wait
 *   bun run cloud:e2e:agents:cleanup -- --base <url> --keep 2 --min-age-minutes 10
 *   bun run cloud:e2e:agents:cleanup -- --protect <agentId> --report <path>
 *   ELIZA_E2E_WALLET_PK=0x... overrides the wallet; ELIZA_CLOUD_AUTH_TOKEN
 *   skips SIWE and uses an existing bearer token instead.
 */

import fs from "node:fs";
import {
  normalizeAgentRow,
  resolveE2eWalletPrivateKey,
  selectAgentsForCleanup,
} from "./e2e-agent-cleanup-lib.mjs";

const argIndex = (name) => process.argv.indexOf(name);
const arg = (name, fallback = null) => {
  const i = argIndex(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const argAll = (name) => {
  const values = [];
  for (let i = 0; i < process.argv.length - 1; i += 1) {
    if (process.argv[i] === name) values.push(process.argv[i + 1]);
  }
  return values;
};
const has = (name) => process.argv.includes(name);
const log = (message) => console.log(`[e2e-agent-cleanup] ${message}`);

if (has("--help") || has("-h")) {
  console.log(
    [
      "Usage: bun scripts/cloud/e2e-agent-cleanup.mjs [options]",
      "  --base <url>             cloud API base (default https://api.eliza.app)",
      "  --apply                  actually delete (default is dry run)",
      "  --wait                   poll 202 delete jobs to completion",
      "  --keep <n>               newest agents to retain (default 1)",
      "  --min-age-minutes <n>    never touch agents younger than this (default 30)",
      "  --protect <agentId>      never delete this agent (repeatable)",
      "  --report <path>          write a JSON report",
    ].join("\n"),
  );
  process.exit(0);
}

const baseUrl = (
  arg("--base") ??
  process.env.ELIZA_CLOUD_API_BASE ??
  "https://api.eliza.app"
).replace(/\/+$/, "");
const keepNewest = Number.parseInt(arg("--keep", "1"), 10);
const minAgeMs = Number.parseFloat(arg("--min-age-minutes", "30")) * 60_000;
const protectIds = argAll("--protect");
const apply = has("--apply");
const wait = has("--wait");
const reportPath = arg("--report");

async function resolveToken() {
  const preset = process.env.ELIZA_CLOUD_AUTH_TOKEN?.trim();
  if (preset) {
    log("using ELIZA_CLOUD_AUTH_TOKEN (skipping SIWE login)");
    return { token: preset, identity: null };
  }
  const { siweTestLogin } = await import(
    "@elizaos/cloud-shared/lib/auth/siwe-test-login"
  );
  const session = await siweTestLogin({
    baseUrl,
    privateKey: resolveE2eWalletPrivateKey(),
  });
  log(
    `SIWE login OK: address=${session.address} org=${session.organizationId} user=${session.userId}`,
  );
  return {
    token: session.apiKey,
    identity: {
      address: session.address,
      userId: session.userId,
      organizationId: session.organizationId,
    },
  };
}

async function cloud(token, path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // error-policy:J3 non-JSON body is reported through the structured error below
  }
  if (!res.ok && body?.success !== true) {
    throw new Error(
      `Cloud request failed (${res.status}) ${path}: ${text.slice(0, 300)}`,
    );
  }
  return { status: res.status, body };
}

async function creditBalance(token) {
  try {
    const res = await cloud(token, "/api/v1/credits/balance");
    return res.body?.balance ?? res.body?.data?.balance ?? null;
  } catch (error) {
    // error-policy:J4 balance is advisory context for the report; the cleanup
    // decision never depends on it, so an unavailable balance is reported as
    // null rather than failing the lane.
    log(`WARN: credit balance unavailable: ${error.message}`);
    return null;
  }
}

async function listAgents(token) {
  const res = await cloud(token, "/api/v1/eliza/agents");
  const rows = Array.isArray(res.body?.data)
    ? res.body.data
    : Array.isArray(res.body)
      ? res.body
      : null;
  if (!rows) {
    throw new Error("Cloud agent list returned an unexpected response shape");
  }
  const normalized = rows.map(normalizeAgentRow);
  const malformedCount = normalized.filter((row) => row === null).length;
  if (malformedCount > 0) {
    throw new Error(
      `Cloud agent list contained ${malformedCount} row(s) without a usable id`,
    );
  }
  return normalized;
}

async function deleteAgent(token, agent) {
  const res = await cloud(
    token,
    `/api/v1/eliza/agents/${encodeURIComponent(agent.id)}`,
    { method: "DELETE" },
  );
  if (res.status === 202) {
    const jobId = res.body?.data?.jobId ?? null;
    if (wait && !jobId) {
      throw new Error(`delete request for ${agent.id} omitted its job id`);
    }
    if (wait) {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const job = await cloud(
          token,
          `/api/v1/jobs/${encodeURIComponent(jobId)}`,
        );
        const status = String(
          job.body?.data?.status ?? job.body?.status ?? "",
        ).toLowerCase();
        if (["completed", "complete", "success", "succeeded"].includes(status))
          return { mode: "job", jobId, final: status };
        if (["failed", "error"].includes(status))
          throw new Error(`delete job ${jobId} for ${agent.id} failed`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
      throw new Error(`delete job ${jobId} for ${agent.id} timed out`);
    }
    return { mode: "job", jobId, final: wait ? "unknown" : "enqueued" };
  }
  return { mode: "sync", final: "deleted" };
}

async function main() {
  const { token, identity } = await resolveToken();
  const balanceBefore = await creditBalance(token);
  const agents = await listAgents(token);
  log(`org has ${agents.length} agent(s); credits=${balanceBefore}`);
  for (const agent of agents) {
    log(
      `  ${agent.id} name="${agent.agentName}" status=${agent.status} tier=${agent.executionTier} createdAt=${
        agent.createdAtMs === null
          ? "unknown"
          : new Date(agent.createdAtMs).toISOString()
      }`,
    );
  }

  const { toDelete, kept } = selectAgentsForCleanup(agents, {
    keepNewest,
    minAgeMs,
    protectIds,
  });
  for (const { agent, reason } of kept) log(`keep   ${agent.id} (${reason})`);
  for (const agent of toDelete)
    log(
      `${apply ? "DELETE" : "would delete"} ${agent.id} ("${agent.agentName}")`,
    );

  const deletions = [];
  if (apply) {
    for (const agent of toDelete) {
      const result = await deleteAgent(token, agent);
      log(`deleted ${agent.id}: ${result.mode}/${result.final}`);
      deletions.push({ agentId: agent.id, ...result });
    }
  }
  const balanceAfter = apply ? await creditBalance(token) : balanceBefore;

  const report = {
    baseUrl,
    apply,
    identity,
    balanceBefore,
    balanceAfter,
    agents,
    kept: kept.map(({ agent, reason }) => ({ agentId: agent.id, reason })),
    toDelete: toDelete.map((agent) => agent.id),
    deletions,
  };
  if (reportPath)
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  log(
    apply
      ? `done: deleted ${deletions.length}/${toDelete.length}`
      : `dry run: ${toDelete.length} agent(s) would be deleted (pass --apply)`,
  );
}

main().catch((error) => {
  console.error(`[e2e-agent-cleanup] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
