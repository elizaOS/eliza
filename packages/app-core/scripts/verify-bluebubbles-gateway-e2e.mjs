#!/usr/bin/env node
/**
 * Strict BlueBubbles egress verifier.
 *
 * This only retries queued replies after the local bridge reports outbound
 * readiness. It passes only when at least one queued reply is actually sent and
 * the pending queue shrinks.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const defaultEvidencePath = path.join(
  repoRoot,
  ".eliza-local",
  "bluebubbles-gateway-e2e-latest.json",
);

function usage() {
  return [
    "Usage: node packages/app-core/scripts/verify-bluebubbles-gateway-e2e.mjs [options]",
    "",
    "Options:",
    "  --limit <n>          Pending replies to retry. Defaults to 1.",
    "  --bridge-url <url>   Local bridge URL. Defaults to http://127.0.0.1:8795.",
    "  --evidence <path>    Write structured proof JSON. Defaults to .eliza-local/bluebubbles-gateway-e2e-latest.json.",
    "  --no-evidence        Do not write a proof JSON file.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    limit: 1,
    bridgeUrl: "http://127.0.0.1:8795",
    evidencePath: defaultEvidencePath,
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
    else if (arg === "--evidence") args.evidencePath = path.resolve(next());
    else if (arg === "--no-evidence") args.evidencePath = null;
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

function writeEvidence({ evidencePath, ok, bridgeUrl, doctor, before, retry, after, error }) {
  if (!evidencePath) return;
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const evidence = {
    ok,
    bridgeUrl,
    checkedAt: new Date().toISOString(),
    doctorStatus: doctor?.status ?? null,
    checks: Array.isArray(doctor?.checks) ? doctor.checks : [],
    before: before ?? null,
    retry: retry ?? null,
    after: after ?? null,
    sentCount: Array.isArray(retry?.sent) ? retry.sent.length : 0,
    pendingBefore: typeof before?.count === "number" ? before.count : null,
    pendingAfter: typeof after?.count === "number" ? after.count : null,
    error: error ? String(error) : null,
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[bluebubbles-e2e] evidence=${evidencePath}`);
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
    const validationBlocked = blockingChecks.some(
      (check) =>
        check.name === "outbound" &&
        /Shortcut outbound validation missing/.test(check.detail ?? ""),
    );
    const validationHint = validationBlocked
      ? " Run: bun run --cwd packages/app-core sms-gateway:validate:bluebubbles -- --confirm-real-send"
      : "";
    const error = `BlueBubbles bridge is not ready: ${blockingChecks
        .map((check) => `${check.name}: ${check.detail}`)
        .join("; ")}.${validationHint}`;
    writeEvidence({
      evidencePath: args.evidencePath,
      ok: false,
      bridgeUrl: args.bridgeUrl,
      doctor,
      error,
    });
    throw new Error(error);
  }

  const before = await getJson(`${args.bridgeUrl}/pending-replies`);
  if (!before.count) {
    const error = "No pending BlueBubbles replies to verify egress";
    writeEvidence({
      evidencePath: args.evidencePath,
      ok: false,
      bridgeUrl: args.bridgeUrl,
      doctor,
      before,
      error,
    });
    throw new Error(error);
  }

  const retry = await postJson(`${args.bridgeUrl}/pending-replies/retry?limit=${args.limit}`);
  const after = await getJson(`${args.bridgeUrl}/pending-replies`);
  if (!Array.isArray(retry.sent) || retry.sent.length === 0) {
    const error = `Retry did not send any replies: ${JSON.stringify(retry)}`;
    writeEvidence({
      evidencePath: args.evidencePath,
      ok: false,
      bridgeUrl: args.bridgeUrl,
      doctor,
      before,
      retry,
      after,
      error,
    });
    throw new Error(error);
  }
  if (after.count >= before.count) {
    const error = `Pending reply count did not decrease: before=${before.count} after=${after.count}`;
    writeEvidence({
      evidencePath: args.evidencePath,
      ok: false,
      bridgeUrl: args.bridgeUrl,
      doctor,
      before,
      retry,
      after,
      error,
    });
    throw new Error(error);
  }

  writeEvidence({
    evidencePath: args.evidencePath,
    ok: true,
    bridgeUrl: args.bridgeUrl,
    doctor,
    before,
    retry,
    after,
  });
  console.log(
    `[bluebubbles-e2e] Sent ${retry.sent.length} queued reply; pending ${before.count} -> ${after.count}.`,
  );
}

main().catch((error) => {
  console.error(`[bluebubbles-e2e] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
