#!/usr/bin/env node
/**
 * Eliza-1 release gateboard.
 *
 * This is intentionally evidence-driven. A release lane must attach a JSON
 * artifact for each required gate under reports/eliza1-release-gates/ (or
 * --evidence-dir). Missing data is a failure, not a warning.
 *
 * Evidence shape:
 *   {
 *     "gate": "live_vast_staging_deploy",
 *     "status": "pass",
 *     "completedAt": "2026-05-12T12:00:00.000Z",
 *     "summary": "..."
 *   }
 *
 * Optional live probe:
 *   VAST_STAGING_BASE_URL=http://host:port VAST_STAGING_API_KEY=...
 *   VAST_STAGING_MODEL=vast/eliza-1-4b \
 *     node scripts/eliza1-release-gates.mjs --probe-vast
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const DEFAULT_EVIDENCE_DIR = path.join(
  REPO_ROOT,
  "reports",
  "eliza1-release-gates",
);

const REQUIRED_GATES = [
  {
    id: "live_vast_staging_deploy",
    label: "Live Vast staging deploy",
    maxAgeHours: 24,
    requiredFields: ["baseUrl", "model", "instanceId"],
  },
  {
    id: "smoke_0_8b",
    label: "Eliza-1 0.8B smoke",
    maxAgeHours: 72,
    requiredFields: ["tier", "modelLoaded", "generationOk"],
  },
  {
    id: "smoke_2b",
    label: "Eliza-1 2B smoke",
    maxAgeHours: 72,
    requiredFields: ["tier", "modelLoaded", "generationOk"],
  },
  {
    id: "smoke_4b",
    label: "Eliza-1 4B smoke",
    maxAgeHours: 72,
    requiredFields: ["tier", "modelLoaded", "generationOk"],
  },
  {
    id: "streaming_tool_call_parity",
    label: "Streaming/tool-call parity",
    maxAgeHours: 168,
    requiredFields: [
      "nonStreamingToolCalls",
      "streamingToolCalls",
      "usageParity",
    ],
  },
  {
    id: "cold_start_burst_load",
    label: "Cold-start and burst load",
    maxAgeHours: 72,
    requiredFields: ["coldStartMs", "burstP95Ms", "errorRate"],
  },
  {
    id: "one_hour_soak",
    label: "1-hour soak",
    maxAgeHours: 72,
    requiredFields: ["durationMs", "crashFree", "rssLeakWithinBudget"],
  },
  {
    id: "failover_kill",
    label: "Failover kill test",
    maxAgeHours: 72,
    requiredFields: [
      "killedNode",
      "fallbackNode",
      "primaryBaseUrl",
      "fallbackBaseUrl",
      "distinctFallbackNode",
      "readinessFlipped",
      "trafficMoved",
    ],
  },
  {
    id: "cost_reconciliation",
    label: "Cost reconciliation",
    maxAgeHours: 24,
    requiredFields: [
      "usageRecordsTotal",
      "ledgerTotal",
      "providerSpendTotal",
      "drift",
    ],
  },
  {
    id: "billing_records",
    label: "Billing records",
    maxAgeHours: 24,
    requiredFields: ["usageRecordId", "creditTransactionId", "idempotencyKey"],
  },
  {
    id: "dashboard_alerts",
    label: "Dashboard alerts",
    maxAgeHours: 24,
    requiredFields: [
      "policiesEvaluated",
      "redStateRendered",
      "alertEventsPersisted",
    ],
  },
  {
    id: "eliza1_quality_perf_evals",
    label: "Eliza-1 quality/performance evals",
    maxAgeHours: 168,
    requiredFields: ["tiers", "gatesPassed", "reportPath"],
  },
];

function parseArgs(argv) {
  const args = {
    evidenceDir: DEFAULT_EVIDENCE_DIR,
    json: false,
    probeVast: false,
    writeProbe: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--evidence-dir") args.evidenceDir = path.resolve(next());
    else if (arg === "--json") args.json = true;
    else if (arg === "--probe-vast") args.probeVast = true;
    else if (arg === "--no-write-probe") args.writeProbe = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/eliza1-release-gates.mjs [--evidence-dir DIR] [--probe-vast] [--json]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function timestampForFile() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function parseDateMs(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectEvidenceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

function loadEvidence(dir) {
  const byGate = new Map();
  for (const file of collectEvidenceFiles(dir)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || typeof data !== "object" || typeof data.gate !== "string")
        continue;
      const completedAt =
        parseDateMs(data.completedAt) ??
        parseDateMs(data.generatedAt) ??
        fs.statSync(file).mtimeMs;
      const current = byGate.get(data.gate);
      if (!current || completedAt > current.completedAtMs) {
        byGate.set(data.gate, {
          file,
          completedAtMs: completedAt,
          data,
        });
      }
    } catch {
      // Ignore partially written or unrelated JSON files.
    }
  }
  return byGate;
}

function checkEvidence(gate, evidence) {
  if (!evidence) {
    return {
      gate: gate.id,
      label: gate.label,
      status: "fail",
      reason: "missing evidence artifact",
    };
  }

  const failures = [];
  if (evidence.data.status !== "pass") {
    failures.push(`status is ${JSON.stringify(evidence.data.status)}`);
  }
  if (evidence.data.standIn === true) {
    failures.push("evidence uses stand-in model");
  }
  const ageHours = (Date.now() - evidence.completedAtMs) / 3_600_000;
  if (ageHours > gate.maxAgeHours) {
    failures.push(
      `evidence is ${ageHours.toFixed(1)}h old; max ${gate.maxAgeHours}h`,
    );
  }
  for (const field of gate.requiredFields) {
    if (!(field in evidence.data)) {
      failures.push(`missing field ${field}`);
    } else if (
      evidence.data[field] === null ||
      evidence.data[field] === undefined ||
      evidence.data[field] === ""
    ) {
      failures.push(`empty field ${field}`);
    }
  }

  return {
    gate: gate.id,
    label: gate.label,
    status: failures.length === 0 ? "pass" : "fail",
    reason: failures.join("; ") || undefined,
    evidence: path.relative(REPO_ROOT, evidence.file),
    completedAt: new Date(evidence.completedAtMs).toISOString(),
    summary: evidence.data.summary,
  };
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`--probe-vast requires ${name}`);
  return value;
}

async function probeVastStaging(evidenceDir) {
  const baseUrl = requireEnv("VAST_STAGING_BASE_URL").replace(/\/+$/, "");
  const apiKey = process.env.VAST_STAGING_API_KEY?.trim() || "not-required";
  const model = process.env.VAST_STAGING_MODEL?.trim() || "vast/eliza-1-4b";
  const instanceId = process.env.VAST_STAGING_INSTANCE_ID?.trim() || "unknown";
  const started = performance.now();

  const modelsRes = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const modelsText = await modelsRes.text();
  if (!modelsRes.ok) {
    throw new Error(
      `/v1/models failed ${modelsRes.status}: ${modelsText.slice(0, 500)}`,
    );
  }

  const chatStarted = performance.now();
  const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "user", content: "Reply with exactly: eliza-vast-smoke" },
      ],
      temperature: 0,
      max_tokens: 16,
      stream: false,
    }),
  });
  const chatText = await chatRes.text();
  if (!chatRes.ok) {
    throw new Error(
      `/v1/chat/completions failed ${chatRes.status}: ${chatText.slice(0, 500)}`,
    );
  }
  const chatJson = JSON.parse(chatText);
  const content = String(chatJson.choices?.[0]?.message?.content ?? "");
  const chatLatencyMs = Math.round(performance.now() - chatStarted);
  const totalLatencyMs = Math.round(performance.now() - started);

  const evidence = {
    gate: "live_vast_staging_deploy",
    status: content.toLowerCase().includes("eliza-vast-smoke")
      ? "pass"
      : "fail",
    completedAt: new Date().toISOString(),
    baseUrl,
    model,
    instanceId,
    modelsStatus: modelsRes.status,
    chatLatencyMs,
    totalLatencyMs,
    usage: chatJson.usage ?? null,
    summary: `Vast staging responded in ${chatLatencyMs}ms`,
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = path.join(
    evidenceDir,
    `vast-staging-${timestampForFile()}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  return { file, evidence };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.probeVast) {
    const { file, evidence } = await probeVastStaging(args.evidenceDir);
    if (!args.json) {
      console.log(
        `[eliza1:gates] wrote ${path.relative(REPO_ROOT, file)} (${evidence.status})`,
      );
    }
  }

  const evidence = loadEvidence(args.evidenceDir);
  const checks = REQUIRED_GATES.map((gate) =>
    checkEvidence(gate, evidence.get(gate.id)),
  );
  const failed = checks.filter((check) => check.status !== "pass");
  const report = {
    status: failed.length === 0 ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    evidenceDir: path.relative(REPO_ROOT, args.evidenceDir),
    checks,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const check of checks) {
      const suffix = check.status === "pass" ? check.evidence : check.reason;
      console.log(
        `[${check.status}] ${check.label}${suffix ? ` - ${suffix}` : ""}`,
      );
    }
  }

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[eliza1:gates] ${err.message}`);
  process.exit(1);
});
