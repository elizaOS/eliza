#!/usr/bin/env node
/**
 * Strict BlueBubbles egress verifier.
 *
 * This only retries queued replies after the local bridge reports outbound
 * readiness. It passes only when at least one queued reply is actually sent and
 * the pending queue shrinks.
 */

function usage() {
  return [
    "Usage: node packages/app-core/scripts/verify-bluebubbles-gateway-e2e.mjs [options]",
    "",
    "Options:",
    "  --limit <n>          Pending replies to retry. Defaults to 1.",
    "  --bridge-url <url>   Local bridge URL. Defaults to http://127.0.0.1:8795.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    limit: 1,
    bridgeUrl: "http://127.0.0.1:8795",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--limit") args.limit = Number.parseInt(next(), 10);
    else if (arg === "--bridge-url") args.bridgeUrl = next().replace(/\/$/, "");
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (!Number.isInteger(args.limit) || args.limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return args;
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${url} failed (${response.status}): ${text}`);
  return body;
}

async function postJson(url) {
  const response = await fetch(url, { method: "POST" });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${url} failed (${response.status}): ${text}`);
  return body;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const doctor = await getJson(`${args.bridgeUrl}/doctor`);
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  const blockingChecks = checks.filter(
    (check) => check.name !== "pending-replies" && check.status !== "pass",
  );
  if (blockingChecks.length > 0) {
    throw new Error(
      `BlueBubbles bridge is not ready: ${blockingChecks
        .map((check) => `${check.name}: ${check.detail}`)
        .join("; ")}`,
    );
  }

  const before = await getJson(`${args.bridgeUrl}/pending-replies`);
  if (!before.count) throw new Error("No pending BlueBubbles replies to verify egress");

  const retry = await postJson(`${args.bridgeUrl}/pending-replies/retry?limit=${args.limit}`);
  const after = await getJson(`${args.bridgeUrl}/pending-replies`);
  if (!Array.isArray(retry.sent) || retry.sent.length === 0) {
    throw new Error(`Retry did not send any replies: ${JSON.stringify(retry)}`);
  }
  if (after.count >= before.count) {
    throw new Error(`Pending reply count did not decrease: before=${before.count} after=${after.count}`);
  }

  console.log(
    `[bluebubbles-e2e] Sent ${retry.sent.length} queued reply; pending ${before.count} -> ${after.count}.`,
  );
}

main().catch((error) => {
  console.error(`[bluebubbles-e2e] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
