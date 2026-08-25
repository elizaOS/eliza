#!/usr/bin/env bun
/**
 * Cleanup lane for cloud agents leaked by the device cloud-onboarding e2e
 * harnesses (issue #14358): every red iOS/Android run can strand another
 * billable dedicated-always agent on the shared e2e SIWE wallet's org, so
 * repeated runs drain credits and stop looking like a first run.
 *
 * Signs in headlessly with the same deterministic e2e wallet the onboarding
 * lanes use (real EIP-4361 handshake — no mock), lists the org's agents, and
 * proposes leaked candidates. Dry-run is the only implicit mode. Mutation
 * requires reviewed candidate IDs, an independently expected SIWE wallet and
 * organization, a durable receipt path, conditional DELETE identity, job
 * completion, and post-delete absence verification.
 *
 * Usage:
 *   bun run cloud:e2e:agents:cleanup                    # dry run vs https://api.eliza.app
 *   bun run cloud:e2e:agents:cleanup -- --report /tmp/cleanup-dry-run.json
 *   bun run cloud:e2e:agents:cleanup -- --apply --wait \
 *     --candidate <reviewed-id> --expected-address <wallet> \
 *     --expected-org <org-id> --report /tmp/cleanup-receipt.json
 *   bun run cloud:e2e:agents:cleanup -- --base <url> --keep 2 --min-age-minutes 10
 *   bun run cloud:e2e:agents:cleanup -- --protect <agentId> --report <path>
 *   ELIZA_E2E_WALLET_PK=0x... overrides the wallet. ELIZA_CLOUD_AUTH_TOKEN
 *   supports remote dry runs only; mutation requires verifiable SIWE except
 *   in deterministic loopback tests.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertExpectedCleanupIdentity,
  bindReviewedCleanupCandidates,
  normalizeAgentRow,
  remainingJobBudget,
  resolveE2eWalletPrivateKey,
  selectAgentsForCleanup,
} from "./e2e-agent-cleanup-lib.mjs";

function argAll(name) {
  const values = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] !== name) continue;
    const value = process.argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    values.push(value);
  }
  return values;
}

const BOOLEAN_OPTIONS = new Set(["--apply", "--wait", "--help", "-h"]);
const VALUE_OPTIONS = new Set([
  "--base",
  "--candidate",
  "--expected-address",
  "--expected-org",
  "--keep",
  "--min-age-minutes",
  "--protect",
  "--report",
  "--job-timeout-ms",
  "--poll-interval-ms",
]);

function validateArgv(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (BOOLEAN_OPTIONS.has(token)) continue;
    if (!VALUE_OPTIONS.has(token)) {
      throw new Error(`unknown or positional argument: ${token}`);
    }
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    index += 1;
  }
}

function arg(name, fallback = null) {
  const values = argAll(name);
  if (values.length > 1) throw new Error(`${name} may only be provided once`);
  return values[0] ?? fallback;
}

validateArgv(process.argv.slice(2));

const has = (name) => process.argv.includes(name);
const log = (message) => console.log(`[e2e-agent-cleanup] ${message}`);

if (has("--help") || has("-h")) {
  console.log(
    [
      "Usage: bun scripts/cloud/e2e-agent-cleanup.mjs [options]",
      "  --base <url>             cloud API base (default https://api.eliza.app)",
      "  --apply                  actually delete (default is dry run)",
      "  --wait                   required with --apply; verify delete jobs",
      "  --candidate <agentId>    reviewed deletion candidate (repeatable)",
      "  --expected-address <0x>  expected SIWE wallet (required to apply)",
      "  --expected-org <uuid>    expected cloud org (required to apply)",
      "  --keep <n>               newest eligible agents to retain (default 0)",
      "  --min-age-minutes <n>    never touch agents younger than this (default 30)",
      "  --protect <agentId>      never delete this agent (repeatable)",
      "  --report <path>          write a JSON receipt (required to apply)",
      "  --job-timeout-ms <n>     delete-job timeout (default 120000)",
      "  --poll-interval-ms <n>   delete-job poll interval (default 5000)",
    ].join("\n"),
  );
  process.exit(0);
}

function parseNumberOption(name, fallback, { integer = false } = {}) {
  const raw = arg(name, fallback);
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error(`${name} must be a non-negative number`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error(
      `${name} must be a non-negative ${integer ? "integer" : "number"}`,
    );
  }
  return value;
}

function parseOptions() {
  const baseUrl = (
    arg("--base") ??
    process.env.ELIZA_CLOUD_API_BASE ??
    "https://api.eliza.app"
  ).replace(/\/+$/, "");
  const parsedBase = new URL(baseUrl);
  if (!/^https?:$/.test(parsedBase.protocol)) {
    throw new Error("--base must be an http(s) URL");
  }
  if (parsedBase.username || parsedBase.password) {
    throw new Error("--base must not contain credentials");
  }
  if (parsedBase.search || parsedBase.hash) {
    throw new Error("--base must not contain a query or fragment");
  }
  const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(
    parsedBase.hostname,
  );
  if (parsedBase.protocol !== "https:" && !isLoopback) {
    throw new Error("--base must use HTTPS unless it is loopback");
  }
  const options = {
    baseUrl,
    apply: has("--apply"),
    wait: has("--wait"),
    candidateIds: argAll("--candidate"),
    expectedAddress: arg("--expected-address"),
    expectedOrganizationId: arg("--expected-org"),
    keepNewest: parseNumberOption("--keep", "0", { integer: true }),
    minAgeMs: parseNumberOption("--min-age-minutes", "30") * 60_000,
    protectIds: argAll("--protect"),
    reportPath: arg("--report"),
    jobTimeoutMs: parseNumberOption("--job-timeout-ms", "120000"),
    pollIntervalMs: parseNumberOption("--poll-interval-ms", "5000"),
    isLoopback,
  };
  for (const id of [...options.candidateIds, ...options.protectIds]) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error(`agent id is malformed: ${id}`);
    }
  }
  if (options.jobTimeoutMs <= 0) {
    throw new Error("--job-timeout-ms must be positive");
  }
  if (options.wait && !options.apply) {
    throw new Error("--wait requires --apply");
  }
  if (options.apply) {
    if (!options.wait) throw new Error("--apply requires --wait");
    if (!options.reportPath) throw new Error("--apply requires --report");
    if (options.candidateIds.length === 0) {
      throw new Error("--apply requires at least one --candidate");
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(options.expectedAddress ?? "")) {
      throw new Error("--apply requires a valid --expected-address");
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        options.expectedOrganizationId ?? "",
      )
    ) {
      throw new Error("--apply requires a valid --expected-org");
    }
  }
  return options;
}

async function resolveToken(options) {
  const preset = process.env.ELIZA_CLOUD_AUTH_TOKEN?.trim();
  if (preset) {
    if (options.apply && !options.isLoopback) {
      throw new Error(
        "ELIZA_CLOUD_AUTH_TOKEN may not apply cleanup against a non-loopback host; use verifiable SIWE",
      );
    }
    log("using ELIZA_CLOUD_AUTH_TOKEN (skipping SIWE login)");
    return {
      token: preset,
      identity: options.apply
        ? {
            address: options.expectedAddress,
            organizationId: options.expectedOrganizationId,
            userId: "loopback-test-user",
          }
        : null,
    };
  }
  const { siweTestLogin } = await import(
    "@elizaos/cloud-shared/lib/auth/siwe-test-login"
  );
  const session = await siweTestLogin({
    baseUrl: options.baseUrl,
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

async function cloud(
  options,
  token,
  requestPath,
  init = {},
  timeoutMs = options.jobTimeoutMs,
) {
  const requestTimeoutMs = Math.min(timeoutMs, 15_000);
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error(`Cloud request deadline elapsed before ${requestPath}`);
  }
  const res = await fetch(`${options.baseUrl}${requestPath}`, {
    ...init,
    signal: AbortSignal.timeout(requestTimeoutMs),
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
  if (!res.ok) {
    throw new Error(
      `Cloud request failed (${res.status}) ${requestPath}: ${text.slice(0, 300)}`,
    );
  }
  return { status: res.status, body };
}

async function creditBalance(options, token) {
  try {
    const res = await cloud(options, token, "/api/v1/credits/balance");
    return res.body?.balance ?? res.body?.data?.balance ?? null;
  } catch (error) {
    // error-policy:J4 balance is advisory context for the report; the cleanup
    // decision never depends on it, so an unavailable balance is reported as
    // null rather than failing the lane.
    log(`WARN: credit balance unavailable: ${error.message}`);
    return null;
  }
}

async function listAgents(options, token) {
  const res = await cloud(options, token, "/api/v1/eliza/agents");
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

async function deleteAgent(options, token, agent) {
  const res = await cloud(
    options,
    token,
    `/api/v1/eliza/agents/${encodeURIComponent(agent.id)}`,
    {
      method: "DELETE",
      body: JSON.stringify({
        expectedAgentName: agent.agentName,
        expectedCreatedAt: agent.createdAt,
        expectedExecutionTier: agent.executionTier,
      }),
    },
  );
  if (res.status === 202) {
    const jobId = res.body?.data?.jobId ?? null;
    if (!jobId) {
      throw new Error(`delete request for ${agent.id} omitted its job id`);
    }
    const timeoutMs = options.jobTimeoutMs;
    const pollIntervalMs = options.pollIntervalMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("--job-timeout-ms must be positive");
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
      throw new Error("--poll-interval-ms must be non-negative");
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remainingMs = remainingJobBudget(
        deadline,
        Number.POSITIVE_INFINITY,
      );
      const job = await cloud(
        options,
        token,
        `/api/v1/jobs/${encodeURIComponent(jobId)}`,
        {},
        remainingMs,
      );
      const status = String(
        job.body?.data?.status ?? job.body?.status ?? "",
      ).toLowerCase();
      if (["completed", "complete", "success", "succeeded"].includes(status))
        return { mode: "job", jobId, final: status };
      if (["failed", "error", "cancelled", "canceled"].includes(status))
        throw new Error(
          `delete job ${jobId} for ${agent.id} failed: ${status}`,
        );
      const sleepMs = remainingJobBudget(deadline, pollIntervalMs);
      if (sleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
    }
    throw new Error(`delete job ${jobId} for ${agent.id} timed out`);
  }
  return { mode: "sync", final: "deleted" };
}

function writeReport(reportPath, report) {
  if (!reportPath) return;
  const directory = path.dirname(reportPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(reportPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(
      fileDescriptor,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(temporaryPath, reportPath);

    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    // error-policy:J2 receipt persistence is a required boundary, so retain
    // the filesystem cause while adding the destination needed to diagnose it.
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      // error-policy:J6 a failed temp-file cleanup must not replace the
      // receipt write failure that stopped mutation and remains actionable.
      if (cleanupError?.code !== "ENOENT") {
        console.warn(
          `[e2e-agent-cleanup] WARN: failed to clean temporary receipt: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    throw new Error(`failed to persist cleanup receipt at ${reportPath}`, {
      cause: error,
    });
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function acquireReportLock(reportPath) {
  if (!reportPath) return () => {};
  const lockPath = `${reportPath}.lock`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor;
    let createdIdentity;
    try {
      descriptor = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      createdIdentity = fs.fstatSync(descriptor);
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      fs.fsyncSync(descriptor);
      const identity = fs.fstatSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      return () => {
        try {
          const current = fs.lstatSync(lockPath);
          if (!sameFileIdentity(identity, current)) {
            throw new Error("report lock changed while cleanup was running");
          }
          fs.unlinkSync(lockPath);
        } catch (error) {
          // error-policy:J6 releasing the advisory receipt lock is teardown;
          // the receipt itself already records the authoritative run result.
          console.warn(
            `[e2e-agent-cleanup] WARN: failed to release report lock: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
    } catch (error) {
      // error-policy:J2 lock acquisition failures gain report-path context and
      // preserve their filesystem cause; EEXIST is inspected fail-closed below.
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (createdIdentity !== undefined) {
        try {
          const current = fs.lstatSync(lockPath);
          if (sameFileIdentity(createdIdentity, current))
            fs.unlinkSync(lockPath);
        } catch (cleanupError) {
          // error-policy:J6 this cleanup only removes a lock created by this
          // failed acquisition; the original failure remains authoritative.
          if (cleanupError?.code !== "ENOENT") {
            console.warn(
              `[e2e-agent-cleanup] WARN: failed to clean incomplete report lock: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
          }
        }
      }
      if (error?.code !== "EEXIST") {
        throw new Error(
          `failed to acquire cleanup report lock at ${lockPath}`,
          {
            cause: error,
          },
        );
      }
    }

    let existingDescriptor;
    let owner;
    let existingIdentity;
    try {
      existingDescriptor = fs.openSync(
        lockPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      existingIdentity = fs.fstatSync(existingDescriptor);
      const text = fs.readFileSync(existingDescriptor, "utf8");
      try {
        owner = JSON.parse(text);
      } catch (error) {
        // error-policy:J3 lock contents are untrusted; malformed ownership can
        // never authorize removal of a potentially live process's lock.
        throw new Error(`cleanup report lock is malformed at ${lockPath}`, {
          cause: error,
        });
      }
    } finally {
      if (existingDescriptor !== undefined) fs.closeSync(existingDescriptor);
    }
    if (
      owner?.hostname !== os.hostname() ||
      !Number.isInteger(owner?.pid) ||
      owner.pid <= 0
    ) {
      throw new Error(`cleanup report is locked by an unverifiable owner`);
    }

    let ownerAlive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      // error-policy:J3 only the OS's definitive no-such-process result makes
      // a same-host lock stale; permissions and unknown errors stay locked.
      if (error?.code === "ESRCH") ownerAlive = false;
      else throw new Error(`cleanup report is locked by pid ${owner.pid}`);
    }
    if (ownerAlive) {
      throw new Error(`cleanup report is locked by active pid ${owner.pid}`);
    }

    const currentIdentity = fs.lstatSync(lockPath);
    if (!sameFileIdentity(existingIdentity, currentIdentity)) {
      throw new Error("cleanup report lock changed during stale-lock recovery");
    }
    fs.unlinkSync(lockPath);
  }
  throw new Error(`failed to acquire cleanup report lock at ${lockPath}`);
}

async function executeCleanup(options) {
  const { token, identity } = await resolveToken(options);
  if (options.apply) {
    assertExpectedCleanupIdentity(identity, options);
  }
  const balanceBefore = await creditBalance(options, token);
  const agents = await listAgents(options, token);
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
    keepNewest: options.keepNewest,
    minAgeMs: options.minAgeMs,
    protectIds: options.protectIds,
  });
  for (const { agent, reason } of kept) log(`keep   ${agent.id} (${reason})`);
  for (const agent of toDelete)
    log(
      `${options.apply ? "eligible" : "would delete"} ${agent.id} ("${agent.agentName}")`,
    );

  const bound = options.apply
    ? bindReviewedCleanupCandidates(agents, toDelete, options.candidateIds)
    : { toDelete, alreadyAbsent: [] };
  const report = {
    baseUrl: options.baseUrl,
    apply: options.apply,
    identity,
    balanceBefore,
    balanceAfter: balanceBefore,
    agents,
    kept: kept.map(({ agent, reason }) => ({ agentId: agent.id, reason })),
    eligible: toDelete.map((agent) => agent.id),
    reviewedCandidates: options.candidateIds,
    alreadyAbsent: bound.alreadyAbsent,
    attempts: [],
    verifiedAbsent: [],
    failure: null,
  };
  writeReport(options.reportPath, report);

  if (options.apply) {
    for (const agent of bound.toDelete) {
      const attempt = {
        agentId: agent.id,
        expectedAgentName: agent.agentName,
        expectedCreatedAt: agent.createdAt,
        expectedExecutionTier: agent.executionTier,
        status: "started",
      };
      report.attempts.push(attempt);
      writeReport(options.reportPath, report);
      try {
        const result = await deleteAgent(options, token, agent);
        Object.assign(attempt, { status: "completed", ...result });
        log(`deleted ${agent.id}: ${result.mode}/${result.final}`);
      } catch (error) {
        attempt.status = "failed";
        attempt.error = error instanceof Error ? error.message : String(error);
        report.failure = attempt.error;
        writeReport(options.reportPath, report);
        throw error;
      }
      writeReport(options.reportPath, report);
    }

    const remaining = new Set(
      (await listAgents(options, token)).map((agent) => agent.id),
    );
    const notAbsent = bound.toDelete.filter((agent) => remaining.has(agent.id));
    if (notAbsent.length > 0) {
      report.failure = `post-delete verification still listed: ${notAbsent
        .map((agent) => agent.id)
        .join(", ")}`;
      writeReport(options.reportPath, report);
      throw new Error(report.failure);
    }
    report.verifiedAbsent = [
      ...bound.alreadyAbsent,
      ...bound.toDelete.map((agent) => agent.id),
    ];
    report.balanceAfter = await creditBalance(options, token);
    writeReport(options.reportPath, report);
  }
  log(
    options.apply
      ? `done: verified ${report.verifiedAbsent.length} reviewed candidate(s) absent`
      : `dry run: ${toDelete.length} eligible agent(s); review IDs before --apply`,
  );
}

async function main() {
  const options = parseOptions();
  const releaseReportLock = acquireReportLock(options.reportPath);
  try {
    await executeCleanup(options);
  } finally {
    releaseReportLock();
  }
}

main().catch((error) => {
  console.error(`[e2e-agent-cleanup] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
