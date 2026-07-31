#!/usr/bin/env node
/**
 * Validates model provenance on contribution claims and on comments that
 * declare AI assistance. Human discussion remains untouched, while claim
 * comments must end in either the canonical machine footer or an explicit
 * human-only footer.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CLAIM_RE = /^\s*CLAIMING(?:\s+(?:REVIEW|LEVER))?\s*:/im;
const ATTRIBUTION_SIGNAL_RE =
  /AI provider\/model\s*:|AI assistance\s*:\s*yes\b|Models?\s+used\s*:|Model\(s\)\s+used\s*:|eliza-computer-attribution:v1/i;
const HUMAN_ONLY_FOOTER_RE =
  /(?:^|\n)AI assistance:\s*no\s*[-\u2013\u2014]\s*human-only (?:claim|comment|review)\s*\nAttribution status:\s*self-reported\s*$/i;
const NO_AI_VALUE_RE = /^(?:no|none|n\/?a)\s*[-:\u2013\u2014]\s*(\S[\s\S]*?)$/i;
const MARKER_RE =
  /<!--\s*eliza-computer-attribution:v1\s+(\{[^\r\n]*\})\s*-->/g;
const ANY_MARKER_RE = /<!--\s*eliza-computer-attribution:v1\b[\s\S]*?-->/g;
const FULL_SKILL_REVISION_RE =
  /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}:[^\s`]+$/i;
const PLACEHOLDER_RE =
  /<[^>]+>|\b(?:unknown|unspecified|placeholder|provider|model|tbd|todo|null)\b/i;
const GENERIC_MODEL_IDS = new Set([
  "ai",
  "claude",
  "gemini",
  "gpt",
  "llama",
  "model",
]);
const GENERIC_PROVIDER_IDS = new Set(["ai", "model", "provider"]);
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const MODEL_ID_RE = /^[a-z0-9][-a-z0-9._:+/]*$/i;

function lineValues(source, labelPattern) {
  const expression = new RegExp(
    `^\\s*(?:[-*]\\s*)?${labelPattern}\\s*:\\s*(.+?)\\s*$`,
    "gim",
  );
  return [...source.matchAll(expression)].map((match) => match[1].trim());
}

function providerSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hasNaWithReason(value) {
  return /^n\/?a\s*[-:\u2013\u2014]\s*(?!<[^>]+>)(?!\[[^\]]+\])\S.{2,}$/i.test(
    value,
  );
}

function isConcrete(value) {
  return value.length >= 2 && !PLACEHOLDER_RE.test(value);
}

function noAiReason(value) {
  return value.match(NO_AI_VALUE_RE)?.[1].trim().toLowerCase() ?? "";
}

function evaluateNoAiIssue(source) {
  const assistanceLines = lineValues(source, "AI assistance");
  if (
    assistanceLines.length === 0 ||
    !/^(?:no|none)\b/i.test(assistanceLines[0])
  ) {
    return null;
  }

  const findings = [];
  const fields = [
    ["ai-assistance", assistanceLines],
    ["provider-model", lineValues(source, "AI provider/model")],
    ["client", lineValues(source, "Client / agent tooling")],
    ["skill-revision", lineValues(source, "Contribution skill revision")],
    ["status", lineValues(source, "Attribution status")],
  ];
  for (const [id, values] of fields) {
    if (values.length !== 1) {
      findings.push({
        id,
        message: `${id} must appear exactly once in a no-AI issue declaration.`,
      });
    }
  }

  const reason = noAiReason(assistanceLines[0] ?? "");
  const modelReason = noAiReason(fields[1][1][0] ?? "");
  const clientReason = noAiReason(fields[2][1][0] ?? "");
  if (
    reason.length < 12 ||
    !/^(?:human-only|deterministic)\b/.test(reason) ||
    modelReason !== reason ||
    clientReason !== reason
  ) {
    findings.push({
      id: "no-ai-reason",
      message:
        "No-AI issue assistance, model, and client rows must use the same specific human-only or deterministic reason.",
    });
  }

  const skillRevision = fields[3][1][0] ?? "";
  if (
    !FULL_SKILL_REVISION_RE.test(skillRevision) &&
    !hasNaWithReason(skillRevision)
  ) {
    findings.push({
      id: "skill-revision",
      message:
        "Contribution skill revision must be owner/repo@full-sha:path or N/A with a reason.",
    });
  }
  if ((fields[4][1][0] ?? "").toLowerCase() !== "self-reported") {
    findings.push({
      id: "status",
      message: "Attribution status must be self-reported.",
    });
  }
  if ([...source.matchAll(ANY_MARKER_RE)].length > 0) {
    findings.push({
      id: "human-only-conflict",
      message: "A no-AI issue must not include a machine-attribution marker.",
    });
  }

  return {
    ok: findings.length === 0,
    skipped: false,
    findings,
    attribution: { kind: "no-ai", reason },
  };
}

export function parseAttributionEvent(path) {
  const event = JSON.parse(readFileSync(path, "utf8"));
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("GitHub event payload must be an object");
  }
  const source = event.comment ?? event.review ?? event.issue;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("GitHub event omitted comment, review, or issue");
  }
  if (source.body === null) {
    return { body: "", kind: event.issue === source ? "issue" : "comment" };
  }
  if (typeof source.body !== "string") {
    throw new TypeError(
      "GitHub comment, review, or issue body must be a string",
    );
  }
  return {
    body: source.body,
    kind: event.issue === source ? "issue" : "comment",
  };
}

export function evaluateCommentAttribution(body, options = {}) {
  const source = String(body ?? "").trim();
  if (options.issueBody === true) {
    const noAiIssue = evaluateNoAiIssue(source);
    if (noAiIssue) return noAiIssue;
  }
  const required =
    options.required === true ||
    options.issueBody === true ||
    CLAIM_RE.test(source) ||
    ATTRIBUTION_SIGNAL_RE.test(source);
  if (!required) {
    return { ok: true, skipped: true, findings: [], attribution: null };
  }

  if (HUMAN_ONLY_FOOTER_RE.test(source)) {
    const conflictingMachineSignal = ATTRIBUTION_SIGNAL_RE.test(source);
    return {
      ok: !conflictingMachineSignal,
      skipped: false,
      findings: conflictingMachineSignal
        ? [
            {
              id: "human-only-conflict",
              message:
                "A human-only footer cannot also contain machine-attribution fields.",
            },
          ]
        : [],
      attribution: { kind: "human-only" },
    };
  }

  const findings = [];
  const modelLines = lineValues(source, "AI provider/model");
  const clientLines = lineValues(source, "Client / agent tooling");
  const revisionLines = lineValues(source, "Contribution skill revision");
  const statusLines = lineValues(source, "Attribution status");
  const markerMatches = [...source.matchAll(MARKER_RE)];
  const allMarkerMatches = [...source.matchAll(ANY_MARKER_RE)];

  for (const [id, values] of [
    ["provider-model", modelLines],
    ["client", clientLines],
    ["skill-revision", revisionLines],
    ["status", statusLines],
  ]) {
    if (values.length !== 1) {
      findings.push({
        id,
        message: `${id} must appear exactly once in the attribution footer.`,
      });
    }
  }
  if (allMarkerMatches.length !== 1 || markerMatches.length !== 1) {
    findings.push({
      id: "marker",
      message:
        "Exactly one well-formed eliza-computer-attribution:v1 JSON marker must appear.",
    });
  }

  const pair = modelLines[0]?.match(/^([^/]+?)\s+\/\s+(.+)$/);
  const provider = pair?.[1].trim() ?? "";
  const model = pair?.[2].trim() ?? "";
  const client = clientLines[0] ?? "";
  const skillRevision = revisionLines[0] ?? "";
  const status = statusLines[0] ?? "";

  if (
    !isConcrete(provider) ||
    !isConcrete(model) ||
    !PROVIDER_ID_RE.test(provider) ||
    !MODEL_ID_RE.test(model) ||
    GENERIC_PROVIDER_IDS.has(provider.toLowerCase()) ||
    GENERIC_MODEL_IDS.has(model.toLowerCase())
  ) {
    findings.push({
      id: "provider-model",
      message:
        "AI provider/model must contain a concrete provider and exact model identifier separated by ` / `.",
    });
  }
  if (!isConcrete(client) || /^n\/?a\b/i.test(client)) {
    findings.push({
      id: "client",
      message: "Client / agent tooling must name the concrete client used.",
    });
  }
  if (
    !FULL_SKILL_REVISION_RE.test(skillRevision) &&
    !hasNaWithReason(skillRevision)
  ) {
    findings.push({
      id: "skill-revision",
      message:
        "Contribution skill revision must be owner/repo@full-sha:path or N/A with a reason.",
    });
  }
  if (status.toLowerCase() !== "self-reported") {
    findings.push({
      id: "status",
      message: "Attribution status must be self-reported.",
    });
  }

  const markerMatch = markerMatches[0];
  let marker = null;
  if (markerMatch) {
    const beforeMarker = source.slice(0, markerMatch.index ?? 0).trimEnd();
    const laneLineRe = /(?:^|\n)(?:—|-)\s*\[([a-z0-9][a-z0-9-]{1,48})\]\s*$/gim;
    const laneMatches = [...beforeMarker.matchAll(laneLineRe)];
    const terminalLane = beforeMarker.match(
      /(?:^|\n)(?:—|-)\s*\[([a-z0-9][a-z0-9-]{1,48})\]\s*$/i,
    );
    const fenceCount = (beforeMarker.match(/```/g) ?? []).length;
    if (
      laneMatches.length !== 1 ||
      terminalLane === null ||
      fenceCount % 2 !== 0
    ) {
      findings.push({
        id: "lane-tag",
        message:
          "Machine-authored comments and issues must carry exactly one terminal lane signature such as `— [qa-agent]` before the marker.",
      });
    }
    if (source.slice((markerMatch.index ?? 0) + markerMatch[0].length).trim()) {
      findings.push({
        id: "marker-position",
        message: "The attribution marker must be the final comment content.",
      });
    }
    try {
      marker = JSON.parse(markerMatch[1]);
    } catch {
      findings.push({
        id: "marker-json",
        message: "The attribution marker must contain valid JSON.",
      });
    }
  }

  if (marker && typeof marker === "object" && !Array.isArray(marker)) {
    const expectedKeys = ["client", "model", "provider", "skill_revision"];
    if (
      Object.keys(marker).sort().join(",") !== expectedKeys.sort().join(",")
    ) {
      findings.push({
        id: "marker-fields",
        message:
          "The attribution marker must contain only provider, model, client, and skill_revision.",
      });
    }
    if (marker.provider !== providerSlug(provider)) {
      findings.push({
        id: "marker-provider",
        message: "Marker provider does not match the visible provider slug.",
      });
    }
    for (const [field, expected] of [
      ["model", model],
      ["client", client],
      ["skill_revision", skillRevision],
    ]) {
      if (marker[field] !== expected) {
        findings.push({
          id: `marker-${field}`,
          message: `Marker ${field} does not match the visible footer.`,
        });
      }
    }
  } else if (marker !== null) {
    findings.push({
      id: "marker-json",
      message: "The attribution marker JSON must be an object.",
    });
  }

  return {
    ok: findings.length === 0,
    skipped: false,
    findings,
    attribution: {
      kind: "machine",
      provider,
      model,
      client,
      skillRevision,
    },
  };
}

function parseArgs(argv) {
  const args = { bodyFile: "", eventFile: "", required: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--body-file") {
      args.bodyFile = argv[index + 1] ?? "";
      index += 1;
    } else if (argv[index] === "--event-file") {
      args.eventFile = argv[index + 1] ?? "";
      index += 1;
    } else if (argv[index] === "--required") {
      args.required = true;
    }
  }
  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if ((args.bodyFile ? 1 : 0) + (args.eventFile ? 1 : 0) !== 1) {
    process.stderr.write(
      "Usage: check-agent-comment-attribution.mjs (--body-file <path> | --event-file <path>) [--required]\n",
    );
    return 2;
  }
  const event = args.eventFile ? parseAttributionEvent(args.eventFile) : null;
  const body = args.bodyFile ? readFileSync(args.bodyFile, "utf8") : event.body;
  const result = evaluateCommentAttribution(body, {
    required: args.required,
    issueBody: event?.kind === "issue",
  });
  if (result.ok) {
    process.stdout.write(
      result.skipped
        ? "No contribution claim or attribution footer to validate.\n"
        : `Contribution comment attribution valid: ${result.attribution.kind}.\n`,
    );
    return 0;
  }
  process.stderr.write("Contribution comment attribution is invalid:\n");
  for (const finding of result.findings) {
    process.stderr.write(`- ${finding.message}\n`);
  }
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runCli();
}
