#!/usr/bin/env node
/**
 * Validates voluntarily supplied model provenance. Comments without an
 * attribution signal are accepted regardless of whether they claim work.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ATTRIBUTION_DECLARATION_RE =
  /^(?:AI provider\/model\s*:|AI assistance\s*:\s*yes\b|Models?(?:\s+used)?\s*:|Model\(s\)\s+used\s*:|Client\s*\/\s*agent tooling\s*:|Contribution skill revision\s*:)/i;
// Two marker generations are accepted: the legacy repository footer
// (eliza-computer-attribution:v1) and the signed run receipt emitted by the
// published contribute-to-eliza skill (elizaos-contribution-attribution:v2),
// whose payload is a superset carrying an additional `run` object.
const ATTRIBUTION_MARKER_LINE_RE =
  /^<!--\s*(?:eliza-computer-attribution:v1|elizaos-contribution-attribution:v2)\b[^\r\n]*-->\s*$/i;
const HUMAN_ONLY_FOOTER_RE =
  /(?:^|\n)AI assistance:\s*no\s*[-\u2013\u2014]\s*human-only (?:claim|comment|review)\s*\nAttribution status:\s*self-reported\s*$/i;
const NO_AI_VALUE_RE = /^(?:no|none|n\/?a)\s*[-:\u2013\u2014]\s*(\S[\s\S]*?)$/i;
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
  "na",
  "none",
]);
const GENERIC_PROVIDER_IDS = new Set(["ai", "model", "na", "none", "provider"]);
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const MODEL_ID_RE = /^[a-z0-9][-a-z0-9._:+/]*$/i;

function identifierKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isGenericProvider(value) {
  return GENERIC_PROVIDER_IDS.has(identifierKey(value));
}

function isGenericModel(value) {
  const segments = value.split("/");
  return (
    GENERIC_MODEL_IDS.has(identifierKey(value)) ||
    GENERIC_MODEL_IDS.has(identifierKey(segments.at(-1) ?? ""))
  );
}

function declarationLineRecords(source) {
  const text = String(source ?? "");
  const records = [];
  let fence = null;
  let offset = 0;
  while (offset <= text.length) {
    const newline = text.indexOf("\n", offset);
    const physicalEnd = newline === -1 ? text.length : newline;
    const raw = text.slice(offset, physicalEnd);
    const sourceLine = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const fenceMatch = sourceLine.match(
      /^\s{0,3}(?:(?:[-*+]|\d+[.)])\s+)?(`{3,}|~{3,})(.*)$/,
    );
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = { character: marker[0], length: marker.length };
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        fenceMatch[2].trim().length === 0
      ) {
        fence = null;
      }
      if (newline === -1) break;
      offset = newline + 1;
      continue;
    }
    if (
      fence !== null ||
      /^\s{0,3}>/.test(sourceLine) ||
      /^(?:\t| {4})/.test(sourceLine)
    ) {
      if (newline === -1) break;
      offset = newline + 1;
      continue;
    }
    const line = sourceLine
      .trim()
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
      .replaceAll("**", "")
      .replaceAll("__", "");
    if (!line.startsWith("`")) {
      records.push({
        end: offset + sourceLine.length,
        normalized: line,
        raw: sourceLine,
        start: offset,
      });
    }
    if (newline === -1) break;
    offset = newline + 1;
  }
  return records;
}

function declarationLines(source) {
  return declarationLineRecords(source).map((record) => record.normalized);
}

function markerRecords(source) {
  return declarationLineRecords(source)
    .map((record) => {
      const raw = record.raw.trim();
      const any = raw.match(
        /^<!--\s*(eliza-computer-attribution:v1|elizaos-contribution-attribution:v2)\b([\s\S]*?)-->\s*$/i,
      );
      if (!any) return null;
      const version = any[1].toLowerCase().endsWith(":v2") ? 2 : 1;
      const wellFormed = raw.match(
        /^<!--\s*(?:eliza-computer-attribution:v1|elizaos-contribution-attribution:v2)\s+(\{[^\r\n]*\})\s*-->\s*$/i,
      );
      const leadingWhitespace =
        record.raw.length - record.raw.trimStart().length;
      return {
        end: record.start + leadingWhitespace + raw.length,
        json: wellFormed?.[1] ?? null,
        start: record.start + leadingWhitespace,
        version,
      };
    })
    .filter((record) => record !== null);
}

function hasHumanOnlyFooter(source) {
  const records = declarationLineRecords(source).filter(
    (record) => record.normalized.length > 0,
  );
  const footer = records
    .slice(-2)
    .map((record) => record.normalized)
    .join("\n");
  const terminal = records.at(-1);
  return (
    terminal !== undefined &&
    HUMAN_ONLY_FOOTER_RE.test(footer) &&
    String(source).slice(terminal.end).trim().length === 0
  );
}

function hasAttributionSignal(source) {
  return declarationLines(source).some(
    (line) =>
      ATTRIBUTION_DECLARATION_RE.test(line) ||
      ATTRIBUTION_MARKER_LINE_RE.test(line),
  );
}

function lineValues(source, labelPattern) {
  const expression = new RegExp(`^${labelPattern}\\s*:\\s*(.+?)\\s*$`, "i");
  return declarationLines(source)
    .map((line) => line.match(expression)?.[1]?.trim())
    .filter((value) => value !== undefined);
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
  if (markerRecords(source).length > 0) {
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

// Legacy issue templates shipped the assistance row as a backticked
// either/or placeholder; a body still carrying it was filed without touching
// the provenance block, so it is unattributed rather than mis-attributed.
const PRISTINE_ASSISTANCE_RE = /^`yes`\s*\/\s*`no\b[^`]*`\s*$/i;

function shouldSkipIssueAttribution(source) {
  const assistanceLines = lineValues(source, "AI assistance");
  if (
    assistanceLines.length > 0 &&
    assistanceLines.every((value) => PRISTINE_ASSISTANCE_RE.test(value))
  ) {
    return true;
  }
  if (
    assistanceLines.length === 0 &&
    !hasAttributionSignal(source) &&
    lineValues(source, "Attribution status").length === 0
  ) {
    return true;
  }
  return false;
}

export function evaluateCommentAttribution(body, options = {}) {
  // Leading indentation is Markdown syntax: trimming it would turn an
  // indented code example into a real contribution declaration.
  const source = String(body ?? "").trimEnd();
  if (options.issueBody === true) {
    const noAiIssue = evaluateNoAiIssue(source);
    if (noAiIssue) return noAiIssue;
    if (shouldSkipIssueAttribution(source)) {
      return {
        ok: true,
        skipped: true,
        findings: [],
        attribution: null,
      };
    }
  }
  const hasDisclosure =
    hasAttributionSignal(source) || hasHumanOnlyFooter(source);
  if (!hasDisclosure) {
    return { ok: true, skipped: true, findings: [], attribution: null };
  }

  if (hasHumanOnlyFooter(source)) {
    const conflictingMachineSignal = hasAttributionSignal(source);
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
  const allMarkerMatches = markerRecords(source);
  const markerMatches = allMarkerMatches.filter(
    (record) => record.json !== null,
  );

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
        "Exactly one well-formed eliza-computer-attribution:v1 or elizaos-contribution-attribution:v2 JSON marker must appear.",
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
    isGenericProvider(provider) ||
    isGenericModel(model)
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
    const laneLineRe = /^(?:—|-)\s*\[([a-z0-9][a-z0-9-]{1,48})\]\s*$/i;
    const beforeMarkerRecords = declarationLineRecords(
      source.slice(0, markerMatch.start),
    ).filter((record) => record.normalized.length > 0);
    const laneMatches = beforeMarkerRecords.filter((record) =>
      laneLineRe.test(record.normalized),
    );
    const terminalLane = beforeMarkerRecords.at(-1);
    if (
      laneMatches.length !== 1 ||
      terminalLane === undefined ||
      !laneLineRe.test(terminalLane.normalized) ||
      source.slice(terminalLane.end, markerMatch.start).trim().length !== 0
    ) {
      findings.push({
        id: "lane-tag",
        message:
          "Machine-authored comments and issues must carry exactly one terminal lane signature such as `— [qa-agent]` before the marker.",
      });
    }
    if (source.slice(markerMatch.end).trim()) {
      findings.push({
        id: "marker-position",
        message: "The attribution marker must be the final comment content.",
      });
    }
    try {
      marker = JSON.parse(markerMatch.json);
    } catch {
      findings.push({
        id: "marker-json",
        message: "The attribution marker must contain valid JSON.",
      });
    }
  }

  if (marker && typeof marker === "object" && !Array.isArray(marker)) {
    // The v2 run receipt adds a signed `run` object; every other key set is
    // identical across versions so mismatched extras stay rejected.
    const expectedKeys =
      markerMatch.version === 2
        ? ["client", "model", "provider", "run", "skill_revision"]
        : ["client", "model", "provider", "skill_revision"];
    if (
      Object.keys(marker).sort().join(",") !== expectedKeys.sort().join(",")
    ) {
      findings.push({
        id: "marker-fields",
        message:
          markerMatch.version === 2
            ? "The v2 attribution marker must contain only provider, model, client, skill_revision, and run."
            : "The attribution marker must contain only provider, model, client, and skill_revision.",
      });
    }
    if (
      markerMatch.version === 2 &&
      (typeof marker.run !== "object" ||
        marker.run === null ||
        Array.isArray(marker.run))
    ) {
      findings.push({
        id: "marker-run",
        message: "The v2 attribution marker run receipt must be an object.",
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
  const args = { bodyFile: "", eventFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--body-file") {
      args.bodyFile = argv[index + 1] ?? "";
      index += 1;
    } else if (argv[index] === "--event-file") {
      args.eventFile = argv[index + 1] ?? "";
      index += 1;
    }
  }
  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if ((args.bodyFile ? 1 : 0) + (args.eventFile ? 1 : 0) !== 1) {
    process.stderr.write(
      "Usage: check-agent-comment-attribution.mjs (--body-file <path> | --event-file <path>)\n",
    );
    return 2;
  }
  const event = args.eventFile ? parseAttributionEvent(args.eventFile) : null;
  const body = args.bodyFile ? readFileSync(args.bodyFile, "utf8") : event.body;
  const result = evaluateCommentAttribution(body, {
    issueBody: event?.kind === "issue",
  });
  if (result.ok) {
    if (result.notice) {
      process.stdout.write(`::warning::${result.notice}\n`);
      return 0;
    }
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
