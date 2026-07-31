#!/usr/bin/env node
/**
 * Fails pull requests that omit the repository's visible AI-assistance and
 * exact model-provenance declaration. The gate cannot detect undisclosed AI
 * use; it makes an explicit human-only or provider/model declaration mandatory
 * so reviewers and the contribution ledger never have to infer provenance.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ATTRIBUTION_MARKER = "contribution-attribution:v1";
const ATTRIBUTION_MARKER_RE = /<!--\s*contribution-attribution:v1\s*-->/gi;
const ROW_RE = /<!--\s*attribution-row:([a-z0-9-]+)\s*-->/gi;
const NO_AI_ASSISTANCE_RE = /^no\s*[-:\u2013\u2014]\s*(\S[\s\S]*?)$/i;
const NO_AI_DETAIL_RE = /^none\s*[-:\u2013\u2014]\s*(\S[\s\S]*?)$/i;
const MODEL_ID_RE =
  /(?:^|[\s,;`])([a-z0-9][a-z0-9._-]*\/[a-z0-9][-a-z0-9._:+/]*)(?=$|[\s,;`])/gi;
const PLACEHOLDER_RE =
  /<[^>]+>|\byes\s*\/\s*no\b|\bprovider\/model\b|\bmodel-name\b|\bfill\b|\btbd\b/i;
const FULL_SKILL_REVISION_RE =
  /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}:[^\s`]+$/i;
const MODEL_SEGMENT_PLACEHOLDERS = new Set([
  "claude",
  "default",
  "gemini",
  "gpt",
  "latest",
  "llama",
  "model",
  "provider",
  "unknown",
  "unspecified",
]);

export const REQUIRED_ATTRIBUTION_ROWS = [
  "ai-assistance",
  "models",
  "client",
  "skill-revision",
  "status",
];

function boundedRow(block) {
  const lines = block.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/<!--\s*attribution-row:/i.test(line) || /^#/.test(line.trim())) break;
    if (line.trim() === "" && kept.length > 0) break;
    if (line.trim() !== "") kept.push(line.trim());
  }
  return kept.join(" ").trim();
}

export function extractAttributionRows(body) {
  const source = String(body ?? "");
  const matches = [...source.matchAll(ROW_RE)].map((match) => ({
    id: match[1].toLowerCase(),
    start: match.index + match[0].length,
  }));
  const rows = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    rows.set(
      current.id,
      boundedRow(source.slice(current.start, next?.start ?? source.length)),
    );
  }
  return rows;
}

export function extractModelIds(value) {
  const ids = new Set();
  for (const match of String(value ?? "").matchAll(MODEL_ID_RE)) {
    const id = match[1].toLowerCase();
    const [provider, ...modelSegments] = id.split("/");
    const model = modelSegments.join("/");
    const finalModelSegment = modelSegments.at(-1) ?? "";
    if (
      !MODEL_SEGMENT_PLACEHOLDERS.has(provider) &&
      !MODEL_SEGMENT_PLACEHOLDERS.has(model) &&
      !MODEL_SEGMENT_PLACEHOLDERS.has(finalModelSegment)
    ) {
      ids.add(id);
    }
  }
  return [...ids].sort();
}

function rowValue(row) {
  return String(row ?? "")
    .replace(/^[-*]\s*/, "")
    .replace(/^[^:]+:\s*/, "")
    .replaceAll("`", "")
    .trim();
}

function normalizeNoAiReason(reason) {
  return String(reason ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^human\s+only\b/, "human-only");
}

function noAiReason(value, pattern) {
  const match = rowValue(value).match(pattern);
  return normalizeNoAiReason(match?.[1]);
}

function isSpecificNoAiReason(reason) {
  return /^(?:human-only|deterministic)\s+\S/.test(reason);
}

function hasConcreteValue(value) {
  const normalized = rowValue(value);
  return normalized.length >= 2 && !PLACEHOLDER_RE.test(normalized);
}

function hasNaWithReason(value) {
  return /^n\/?a\s*[-:\u2013\u2014]\s*(?!<[^>]+>)(?!\[[^\]]+\])\S.{2,}$/i.test(
    rowValue(value),
  );
}

function hasConcreteSkillRevision(value) {
  const normalized = rowValue(value);
  return FULL_SKILL_REVISION_RE.test(normalized) || hasNaWithReason(normalized);
}

export function evaluatePrAttribution(body) {
  const source = String(body ?? "");
  const rows = extractAttributionRows(source);
  const rowMarkers = [...source.matchAll(ROW_RE)].map((match) =>
    match[1].toLowerCase(),
  );
  const findings = [];

  const markerCount = [...source.matchAll(ATTRIBUTION_MARKER_RE)].length;
  if (markerCount !== 1) {
    findings.push({
      id: "marker",
      status: markerCount === 0 ? "missing" : "duplicate",
      message:
        markerCount === 0
          ? `Missing <!-- ${ATTRIBUTION_MARKER} -->.`
          : `Expected exactly one <!-- ${ATTRIBUTION_MARKER} -->; found ${markerCount}.`,
    });
  }

  for (const id of REQUIRED_ATTRIBUTION_ROWS) {
    const rowCount = rowMarkers.filter((marker) => marker === id).length;
    if (rowCount === 0) {
      findings.push({
        id,
        status: "missing",
        message: `Missing attribution row marker: ${id}.`,
      });
    } else if (rowCount > 1) {
      findings.push({
        id,
        status: "duplicate",
        message: `Attribution row marker ${id} must appear exactly once.`,
      });
    } else if (!hasConcreteValue(rows.get(id))) {
      findings.push({
        id,
        status: "placeholder",
        message: `Attribution row ${id} still contains a placeholder.`,
      });
    }
  }

  const assistance = rowValue(rows.get("ai-assistance"));
  const models = rowValue(rows.get("models"));
  const client = rowValue(rows.get("client"));
  const status = rowValue(rows.get("status"));
  const noAi = /^no\b/i.test(assistance);
  const modelIds = extractModelIds(models);
  const assistanceReason = noAiReason(
    rows.get("ai-assistance"),
    NO_AI_ASSISTANCE_RE,
  );
  const modelReason = noAiReason(rows.get("models"), NO_AI_DETAIL_RE);
  const clientReason = noAiReason(rows.get("client"), NO_AI_DETAIL_RE);
  const noAiKind = assistanceReason.startsWith("human-only ")
    ? "human-only"
    : assistanceReason.startsWith("deterministic ")
      ? "deterministic"
      : "no-ai";

  if (rows.has("ai-assistance") && !/^(yes|no)\b/i.test(assistance)) {
    findings.push({
      id: "ai-assistance",
      status: "invalid",
      message: "AI assistance must begin with yes or no.",
    });
  }

  if (noAi) {
    if (
      !isSpecificNoAiReason(assistanceReason) ||
      modelReason !== assistanceReason ||
      clientReason !== assistanceReason
    ) {
      findings.push({
        id: "no-ai-reason",
        status: "invalid",
        message:
          "No-AI assistance, model, and client rows must use the same specific human-only or deterministic reason.",
      });
    }
    if (modelReason !== assistanceReason) {
      findings.push({
        id: "models",
        status: "invalid",
        message:
          "No-AI work must state `None - <the same specific reason>` for models.",
      });
    }
    if (clientReason !== assistanceReason) {
      findings.push({
        id: "client",
        status: "invalid",
        message:
          "No-AI work must state `None - <the same specific reason>` for client tooling.",
      });
    }
  } else if (rows.has("models") && modelIds.length === 0) {
    findings.push({
      id: "models",
      status: "invalid",
      message:
        "AI-assisted work must name at least one exact provider/model identifier.",
    });
  }

  if (!noAi && rows.has("client") && NO_AI_DETAIL_RE.test(client)) {
    findings.push({
      id: "client",
      status: "invalid",
      message: "AI-assisted work must name the client or agent tooling used.",
    });
  }

  if (
    !noAi &&
    rows.has("client") &&
    (/^n\/?a\b/i.test(client) || !hasConcreteValue(client))
  ) {
    findings.push({
      id: "client",
      status: "invalid",
      message: "AI-assisted work must name a concrete client or agent tool.",
    });
  }

  if (
    rows.has("skill-revision") &&
    !hasConcreteSkillRevision(rows.get("skill-revision"))
  ) {
    findings.push({
      id: "skill-revision",
      status: "invalid",
      message:
        "Skill revision must be owner/repo@full-commit-sha:path or `N/A - <specific reason>`.",
    });
  }

  if (rows.has("status") && !/^self-reported$/i.test(status)) {
    findings.push({
      id: "status",
      status: "invalid",
      message: "Attribution status must be explicitly marked self-reported.",
    });
  }

  return {
    ok: findings.length === 0,
    findings,
    attribution: {
      aiAssistance: noAi ? "no" : "yes",
      kind: noAi ? noAiKind : "ai-assisted",
      noAiReason: noAi ? assistanceReason : "",
      modelIds,
      client,
      skillRevision: rowValue(rows.get("skill-revision")),
      status,
    },
  };
}

function parseArgs(argv) {
  const args = { bodyFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--body-file") {
      args.bodyFile = argv[index + 1] ?? "";
      index += 1;
    }
  }
  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  const { bodyFile } = parseArgs(argv);
  if (!bodyFile) {
    process.stderr.write(
      "Usage: check-pr-agent-attribution.mjs --body-file <path>\n",
    );
    return 2;
  }

  const result = evaluatePrAttribution(readFileSync(bodyFile, "utf8"));
  if (result.ok) {
    process.stdout.write(
      `Contribution attribution valid: ${
        result.attribution.aiAssistance === "no"
          ? result.attribution.kind
          : result.attribution.modelIds.join(", ")
      }.\n`,
    );
    return 0;
  }

  process.stderr.write("Contribution attribution is incomplete:\n");
  for (const finding of result.findings) {
    process.stderr.write(`- ${finding.message}\n`);
  }
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runCli();
}
