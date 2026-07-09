#!/usr/bin/env node
/**
 * Evidence expectation matrix for open LifeOps MVP issues. The board can show
 * that a row is human-gated, but closeout still needs a concrete proof contract
 * per issue so screenshots, videos, logs, trajectories, and domain artifacts do
 * not collapse into a vague "needs review" bucket.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const DEFAULT_REPO = "elizaOS/eliza";
const DEFAULT_PROJECT_OWNER = "elizaOS";
const DEFAULT_PROJECT_NUMBER = "15";
const DEFAULT_LIMIT = "300";
const HUMAN_LABELS = new Set(["needs-human", "needs-shaw"]);

const BASE_EVIDENCE = [
  {
    id: "issue-closeout-summary",
    label: "Issue/PR closeout summary",
    reason:
      "Every MVP row needs an inline GitHub comment naming what changed, what was verified, and what remains human-owned.",
  },
  {
    id: "logs",
    label: "Relevant structured logs",
    reason:
      "The closeout standard requires the real client/server path to be observable instead of inferred from code.",
  },
  {
    id: "domain-artifacts",
    label: "Domain artifacts",
    reason:
      "The issue should show the records, files, memories, scheduled tasks, or generated artifacts that prove the workflow ran.",
  },
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasToken(text, token) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(token)}([^a-z0-9]|$)`).test(
    text,
  );
}

function hasAnyToken(text, tokens) {
  return tokens.some((token) => hasToken(text, token));
}

const RULES = [
  {
    id: "visual-review",
    evidence: {
      id: "visual-screenshots-ocr-color",
      label: "Before/after screenshots with OCR and color heuristics",
      reason:
        "UI/app work must prove the rendered state, readable text, palette, and obvious layout defects on desktop and mobile.",
    },
    matches: ({ text, labels }) =>
      labels.has("ui") ||
      labels.has("ux") ||
      labels.has("Design") ||
      hasAnyToken(text, ["onboarding", "view", "views"]) ||
      text.includes("sharing ux"),
  },
  {
    id: "walkthrough",
    evidence: {
      id: "walkthrough-video",
      label: "MP4 walkthrough",
      reason:
        "User-facing flows need a human-reviewable recording of the real journey, including transitions and error/empty states.",
    },
    matches: ({ text, labels }) =>
      labels.has("ui") ||
      labels.has("ux") ||
      labels.has("voice") ||
      hasAnyToken(text, ["onboarding", "device", "permissioning"]),
  },
  {
    id: "device",
    evidence: {
      id: "device-artifact-bundle",
      label: "Per-device screenshots, recording, logs, and status JSON",
      reason:
        "Device-gated MVP rows must prove the installed app and platform bridge behavior, not a desktop browser surrogate.",
    },
    matches: ({ text }) =>
      hasAnyToken(text, ["device", "ios", "android", "ipad", "sim", "emu"]),
  },
  {
    id: "voice",
    evidence: {
      id: "voice-audio-latency",
      label: "Audio sample, transcript, and latency/quality numbers",
      reason:
        "Voice rows need audible proof plus measured ASR/TTS behavior so success is not judged by a text-only path.",
    },
    matches: ({ text, labels }) =>
      labels.has("voice") ||
      hasAnyToken(text, ["voice", "tts", "stt", "whisper", "kokoro", "audio"]),
  },
  {
    id: "live-llm",
    evidence: {
      id: "live-llm-trajectory",
      label: "Live-LLM scenario trajectory report",
      reason:
        "Agent, scenario, planner, memory, and persona behavior must be proven with model inputs and outputs, not mocks.",
    },
    matches: ({ text, labels }) =>
      labels.has("testing") ||
      labels.has("Plugin") ||
      labels.has("memory") ||
      hasAnyToken(text, [
        "scenario",
        "scenarios",
        "pack",
        "persona",
        "scheduler",
        "lifeops",
      ]),
  },
  {
    id: "connector",
    evidence: {
      id: "connector-dispatch-proof",
      label:
        "Connector dispatch or import transcript with credential-safe logs",
      reason:
        "Connector and corpus rows need the real external/channel boundary exercised or a named owner-owned credential blocker.",
    },
    matches: ({ text, labels }) =>
      labels.has("connector") ||
      hasAnyToken(text, [
        "gmail",
        "telegram",
        "discord",
        "imessage",
        "signal",
        "whatsapp",
        "collector",
        "corpus",
      ]) ||
      text.includes("x.com"),
  },
  {
    id: "security",
    evidence: {
      id: "security-redaction-proof",
      label: "Security/redaction proof and negative-path evidence",
      reason:
        "Security, PII, permissioning, and privacy rows need leak checks, denial paths, and fail-closed behavior.",
    },
    matches: ({ text, labels }) =>
      labels.has("security") ||
      hasAnyToken(text, [
        "pii",
        "redact",
        "redaction",
        "permission",
        "permissioning",
        "private",
        "zero-leak",
      ]) ||
      text.includes("delete-for-everyone"),
  },
  {
    id: "scheduled",
    evidence: {
      id: "scheduled-task-state",
      label: "ScheduledTask/ledger state before and after",
      reason:
        "Reminder, follow-up, watcher, and obligation rows must show structural task records and completion/escalation state.",
    },
    matches: ({ text }) =>
      hasAnyToken(text, [
        "scheduled",
        "reminder",
        "reminders",
        "follow-up",
        "watcher",
        "obligation",
        "obligations",
        "check-in",
        "task",
        "tasks",
      ]),
  },
];

function usage() {
  return `Usage:
  node packages/scripts/audit-mvp-evidence-matrix.mjs [--json]
  node packages/scripts/audit-mvp-evidence-matrix.mjs --issues-json issues.json --project-json project.json [--json]

Options:
  --repo <owner/repo>             GitHub repo for live mode (default: ${DEFAULT_REPO}).
  --project-owner <org>          GitHub Project owner for live mode (default: ${DEFAULT_PROJECT_OWNER}).
  --project-number <number>      GitHub Project number for live mode (default: ${DEFAULT_PROJECT_NUMBER}).
  --limit <n>                    GitHub issue/project limit (default: ${DEFAULT_LIMIT}).`;
}

function parseArgs(argv) {
  const out = {
    repo: DEFAULT_REPO,
    projectOwner: DEFAULT_PROJECT_OWNER,
    projectNumber: DEFAULT_PROJECT_NUMBER,
    limit: DEFAULT_LIMIT,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (
      arg === "--repo" ||
      arg === "--project-owner" ||
      arg === "--project-number" ||
      arg === "--limit" ||
      arg === "--issues-json" ||
      arg === "--project-json"
    ) {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      out[
        arg
          .slice(2)
          .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
      ] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function labelNames(issue) {
  return (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
}

function normalizeRepository(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const githubPrefix = "https://github.com/";
  const normalized = value.startsWith(githubPrefix)
    ? value.slice(githubPrefix.length)
    : value;
  return normalized.replace(/\.git$/, "").toLowerCase();
}

function projectItemRepository(item) {
  return normalizeRepository(
    item.content?.repository ?? item.repository ?? item.content?.url,
  );
}

function projectItemNumber(item) {
  return item.content?.number ?? item.number ?? null;
}

function projectStatusByNumber(payload, repo = DEFAULT_REPO) {
  const expectedRepo = normalizeRepository(repo);
  const byNumber = new Map();
  for (const item of Array.isArray(payload) ? payload : (payload.items ?? [])) {
    if (item.content?.type && item.content.type !== "Issue") continue;
    const itemRepo = projectItemRepository(item);
    if (expectedRepo && itemRepo && itemRepo !== expectedRepo) continue;
    const number = projectItemNumber(item);
    if (typeof number === "number") byNumber.set(number, item.status ?? null);
  }
  return byNumber;
}

function dedupeEvidence(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function classifyIssue(issue) {
  const labels = new Set(labelNames(issue));
  const title = issue.title ?? "";
  const body = issue.body ?? "";
  const text = `${title}\n${body}`.toLowerCase();
  const matchedRules = RULES.filter((rule) => rule.matches({ text, labels }));
  const evidence = dedupeEvidence([
    ...BASE_EVIDENCE,
    ...matchedRules.map((rule) => rule.evidence),
  ]);
  return {
    number: issue.number,
    title,
    url: issue.url,
    labels: [...labels],
    blockerLabels: [...labels].filter((label) => HUMAN_LABELS.has(label)),
    projectStatus: issue.projectStatus ?? null,
    matchedRules: matchedRules.map((rule) => rule.id),
    evidence,
  };
}

function evidenceCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const evidence of row.evidence) {
      counts.set(evidence.id, (counts.get(evidence.id) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts.entries()].sort());
}

export function buildEvidenceMatrix(issues, projectPayload, options = {}) {
  const statusByNumber = projectStatusByNumber(
    projectPayload,
    options.repo ?? DEFAULT_REPO,
  );
  const rows = issues
    .map((issue) => ({
      ...issue,
      projectStatus: statusByNumber.get(issue.number) ?? null,
    }))
    .map(classifyIssue)
    .sort((a, b) => a.number - b.number);
  const humanGated = rows.filter((row) => row.blockerLabels.length > 0);
  const agentActionable = rows.filter((row) => row.blockerLabels.length === 0);
  return {
    counts: {
      openMvpIssues: rows.length,
      humanGated: humanGated.length,
      agentActionable: agentActionable.length,
    },
    evidenceCounts: evidenceCounts(rows),
    agentActionable,
    rows,
  };
}

function formatText(report) {
  const lines = [
    "LifeOps MVP evidence matrix",
    `open MVP issues: ${report.counts.openMvpIssues}`,
    `human-gated: ${report.counts.humanGated}; agent-actionable: ${report.counts.agentActionable}`,
    "",
    "Evidence coverage:",
  ];
  for (const [id, count] of Object.entries(report.evidenceCounts)) {
    lines.push(`  ${id}: ${count}`);
  }
  lines.push("", "Open issue expectations:");
  for (const row of report.rows) {
    lines.push(
      `  #${row.number} ${row.projectStatus ?? "(no project status)"} — ${row.title}`,
    );
    lines.push(
      `    evidence: ${row.evidence.map((evidence) => evidence.id).join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (
    (args.issuesJson && !args.projectJson) ||
    (!args.issuesJson && args.projectJson)
  ) {
    throw new Error("--issues-json and --project-json must be passed together");
  }

  const issues = args.issuesJson
    ? readJson(args.issuesJson)
    : ghJson([
        "issue",
        "list",
        "--repo",
        args.repo,
        "--state",
        "open",
        "--label",
        "mvp",
        "--limit",
        args.limit,
        "--json",
        "number,title,body,labels,url",
      ]);
  const projectPayload = args.projectJson
    ? readJson(args.projectJson)
    : ghJson([
        "project",
        "item-list",
        args.projectNumber,
        "--owner",
        args.projectOwner,
        "--limit",
        args.limit,
        "--format",
        "json",
      ]);
  const report = buildEvidenceMatrix(issues, projectPayload, {
    repo: args.repo,
  });
  process.stdout.write(
    args.json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `[audit-mvp-evidence-matrix] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
