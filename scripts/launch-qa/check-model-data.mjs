#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, "../..");

const SKIP_DIRS = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const SECRET_PATTERNS = [
  { label: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { label: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { label: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g },
  {
    label: "github-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  },
  { label: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  {
    label: "stripe-secret-key",
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  {
    label: "credential-assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/gi,
  },
];

function rel(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function safeReadJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function walkFiles(dir) {
  if (!exists(dir) || !isDirectory(dir)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function isArtifactJson(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return (
    name.endsWith(".json") &&
    (name.includes("trajectory") ||
      name.includes("finetune") ||
      name.includes("fine-tune") ||
      name.includes("dataset"))
  );
}

function collectCandidateFiles(repoRoot, inputPaths) {
  const scanRoots =
    inputPaths.length > 0
      ? inputPaths.map((inputPath) => path.resolve(repoRoot, inputPath))
      : [
          path.join(repoRoot, "plugins", "app-training", "datasets"),
          path.join(repoRoot, "launchdocs", "artifacts"),
        ];

  const files = new Set();
  for (const scanRoot of scanRoots) {
    if (!exists(scanRoot)) {
      continue;
    }
    const candidates = isDirectory(scanRoot) ? walkFiles(scanRoot) : [scanRoot];
    for (const filePath of candidates) {
      if (filePath.endsWith(".jsonl") || isArtifactJson(filePath)) {
        files.add(filePath);
      }
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function approxTokens(text) {
  return Math.ceil(text.length / 4);
}

function addError(errors, repoRoot, filePath, fields) {
  errors.push({
    file: rel(repoRoot, filePath),
    ...fields,
  });
}

function findSecretHits(text) {
  const hits = [];
  for (const { label, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      hits.push({ label, offset: match.index ?? 0 });
    }
  }
  return hits;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMetadataAndReward(row, errors) {
  if (
    "metadata" in row &&
    (typeof row.metadata !== "object" || row.metadata === null)
  ) {
    errors.push("row.metadata must be an object when present");
  }
  if ("reward" in row && typeof row.reward !== "number") {
    errors.push("row.reward must be a number when present");
  }
}

function validateMessageArray(messages, label) {
  const errors = [];
  const stats = { hasUser: false, hasAssistant: false };
  if (!Array.isArray(messages)) {
    return { errors: [`${label} must be an array`], stats };
  }
  if (messages.length === 0) {
    errors.push(`${label} must not be empty`);
  }

  messages.forEach((message, index) => {
    if (!isRecord(message)) {
      errors.push(`${label}[${index}] must be an object`);
      return;
    }
    const role = message.role;
    if (
      !["system", "developer", "user", "model", "assistant", "tool"].includes(
        role,
      )
    ) {
      errors.push(
        `${label}[${index}].role must be system, developer, user, model, assistant, or tool`,
      );
    }
    if (typeof message.content !== "string" || message.content.trim() === "") {
      errors.push(`${label}[${index}].content must be a non-empty string`);
    }
    if (role === "user") stats.hasUser = true;
    if (role === "model" || role === "assistant") stats.hasAssistant = true;
  });

  return { errors, stats };
}

function validateElizaNativeRow(row) {
  const errors = [];
  if (!isRecord(row)) {
    return ["row must be a JSON object"];
  }
  if (row.format !== "eliza_native_v1") {
    errors.push('row.format must be "eliza_native_v1"');
  }
  if ("boundary" in row && typeof row.boundary !== "string") {
    errors.push("row.boundary must be a string when present");
  }

  const request = row.request;
  if (!isRecord(request)) {
    errors.push("row.request must be an object");
  } else {
    if ("system" in request && typeof request.system !== "string") {
      errors.push("row.request.system must be a string when present");
    }
    const hasPrompt =
      typeof request.prompt === "string" && request.prompt.trim() !== "";
    let hasUser = hasPrompt;
    if ("prompt" in request && typeof request.prompt !== "string") {
      errors.push("row.request.prompt must be a string when present");
    }
    if ("messages" in request) {
      const result = validateMessageArray(
        request.messages,
        "row.request.messages",
      );
      errors.push(...result.errors);
      hasUser = hasUser || result.stats.hasUser;
    } else if (!hasPrompt) {
      errors.push("row.request must include messages or prompt");
    }
    if (!hasUser) {
      errors.push(
        "row.request must include at least one user message or prompt",
      );
    }
  }

  const response = row.response;
  if (!isRecord(response)) {
    errors.push("row.response must be an object");
  } else {
    let hasResponse = false;
    if ("text" in response) {
      if (typeof response.text !== "string") {
        errors.push("row.response.text must be a string when present");
      } else if (response.text.trim() !== "") {
        hasResponse = true;
      }
    }
    if ("toolCalls" in response) {
      if (!Array.isArray(response.toolCalls)) {
        errors.push("row.response.toolCalls must be an array when present");
      } else if (response.toolCalls.length > 0) {
        hasResponse = true;
      }
    }
    if (!hasResponse) {
      errors.push("row.response must include non-empty text or toolCalls");
    }
  }

  validateMetadataAndReward(row, errors);
  return errors;
}

function validateMessagesRow(row) {
  const errors = [];
  if (!isRecord(row)) {
    return ["row must be a JSON object"];
  }

  if (row.format === "eliza_native_v1") {
    return validateElizaNativeRow(row);
  }

  if (!Array.isArray(row.messages)) {
    return ["row.messages must be an array"];
  }
  const result = validateMessageArray(row.messages, "row.messages");
  errors.push(...result.errors);

  if (!result.stats.hasUser) {
    errors.push("row.messages must include at least one user message");
  }
  if (!result.stats.hasAssistant) {
    errors.push(
      "row.messages must include at least one model or assistant message",
    );
  }
  validateMetadataAndReward(row, errors);

  return errors;
}

function collectRowTextStats(row) {
  const roles = {};
  let contentChars = 0;
  const addMessage = (message) => {
    if (!isRecord(message)) return;
    if (typeof message.role === "string") {
      roles[message.role] = (roles[message.role] ?? 0) + 1;
    }
    if (typeof message.content === "string") {
      contentChars += message.content.length;
    }
  };
  const addText = (value) => {
    if (typeof value === "string") {
      contentChars += value.length;
    }
  };

  if (row?.format === "eliza_native_v1") {
    addText(row.request?.system);
    addText(row.request?.prompt);
    for (const message of Array.isArray(row.request?.messages)
      ? row.request.messages
      : []) {
      addMessage(message);
    }
    addText(row.response?.text);
    if (Array.isArray(row.response?.toolCalls)) {
      contentChars += JSON.stringify(row.response.toolCalls).length;
    }
    return { roles, contentChars };
  }

  for (const message of Array.isArray(row?.messages) ? row.messages : []) {
    addMessage(message);
  }
  return { roles, contentChars };
}

function checkJsonlFile({ repoRoot, filePath }) {
  const errors = [];
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  let rowCount = 0;
  let secretHitCount = 0;
  let contentChars = 0;
  const roles = {};

  lines.forEach((line, index) => {
    if (line.trim() === "") {
      return;
    }
    rowCount += 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      addError(errors, repoRoot, filePath, {
        type: "invalid-jsonl",
        line: index + 1,
        message: `line ${index + 1} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }

    for (const rowError of validateMessagesRow(row)) {
      addError(errors, repoRoot, filePath, {
        type: "invalid-row-schema",
        line: index + 1,
        message: `line ${index + 1}: ${rowError}`,
      });
    }

    const rowTextStats = collectRowTextStats(row);
    contentChars += rowTextStats.contentChars;
    for (const [role, count] of Object.entries(rowTextStats.roles)) {
      roles[role] = (roles[role] ?? 0) + count;
    }

    const secretHits = findSecretHits(line);
    secretHitCount += secretHits.length;
    for (const hit of secretHits) {
      addError(errors, repoRoot, filePath, {
        type: "secret-like-string",
        line: index + 1,
        label: hit.label,
        message: `line ${index + 1} contains secret-like string (${hit.label})`,
      });
    }
  });

  if (rowCount === 0) {
    addError(errors, repoRoot, filePath, {
      type: "empty-jsonl",
      message: "JSONL file has no non-empty rows",
    });
  }

  return {
    kind: "jsonl",
    file: rel(repoRoot, filePath),
    rows: rowCount,
    bytes: fs.statSync(filePath).size,
    approxTokens: approxTokens(raw),
    contentApproxTokens: approxTokens("x".repeat(contentChars)),
    roles,
    secretHits: secretHitCount,
    errors,
  };
}

function metadataCandidatesFor(jsonlPath) {
  const dir = path.dirname(jsonlPath);
  const ext = path.extname(jsonlPath);
  const baseWithoutExt = path.basename(jsonlPath, ext);
  return [
    path.join(dir, `${baseWithoutExt}.meta.json`),
    path.join(dir, `${path.basename(jsonlPath)}.meta.json`),
  ];
}

function checkMetadataForJsonl({ repoRoot, jsonlPath, rowCount }) {
  const errors = [];
  const metadataPath = metadataCandidatesFor(jsonlPath).find((candidate) =>
    exists(candidate),
  );
  if (!metadataPath) {
    return { metadataFile: null, errors };
  }

  const parsed = safeReadJson(metadataPath);
  if (!parsed.ok) {
    addError(errors, repoRoot, metadataPath, {
      type: "invalid-metadata-json",
      message: `metadata JSON did not parse: ${parsed.error}`,
    });
    return { metadataFile: rel(repoRoot, metadataPath), errors };
  }

  const metadata = parsed.value;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    addError(errors, repoRoot, metadataPath, {
      type: "invalid-metadata-schema",
      message: "metadata JSON must be an object",
    });
    return { metadataFile: rel(repoRoot, metadataPath), errors };
  }

  for (const field of [
    "rowCount",
    "caseCount",
    "exampleCount",
    "sampleCount",
  ]) {
    if (
      field in metadata &&
      typeof metadata[field] === "number" &&
      metadata[field] !== rowCount
    ) {
      addError(errors, repoRoot, metadataPath, {
        type: "metadata-row-count-mismatch",
        field,
        expected: rowCount,
        actual: metadata[field],
        message: `metadata ${field}=${metadata[field]} does not match JSONL rows=${rowCount}`,
      });
    }
  }

  const outcomeFields = ["passCount", "failCount", "rejectedCount"];
  if (outcomeFields.every((field) => typeof metadata[field] === "number")) {
    const total = outcomeFields.reduce(
      (sum, field) => sum + metadata[field],
      0,
    );
    if (total !== rowCount) {
      addError(errors, repoRoot, metadataPath, {
        type: "metadata-outcome-count-mismatch",
        expected: rowCount,
        actual: total,
        message: `metadata pass/fail/rejected total=${total} does not match JSONL rows=${rowCount}`,
      });
    }
  }

  const raw = fs.readFileSync(metadataPath, "utf8");
  for (const hit of findSecretHits(raw)) {
    addError(errors, repoRoot, metadataPath, {
      type: "secret-like-string",
      label: hit.label,
      message: `metadata contains secret-like string (${hit.label})`,
    });
  }

  return { metadataFile: rel(repoRoot, metadataPath), errors };
}

function looksLikeTrajectoryArtifact(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "object" && item !== null);
  }
  return (
    Array.isArray(value.trajectories) ||
    Array.isArray(value.steps) ||
    Array.isArray(value.messages) ||
    typeof value.trajectoryId === "string" ||
    typeof value.datasetId === "string" ||
    typeof value.model === "string"
  );
}

function checkJsonArtifact({ repoRoot, filePath }) {
  const errors = [];
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = safeReadJson(filePath);
  if (!parsed.ok) {
    addError(errors, repoRoot, filePath, {
      type: "invalid-json-artifact",
      message: `JSON artifact did not parse: ${parsed.error}`,
    });
  } else if (!looksLikeTrajectoryArtifact(parsed.value)) {
    addError(errors, repoRoot, filePath, {
      type: "invalid-artifact-schema",
      message:
        "artifact JSON must include trajectories, steps, messages, trajectoryId, datasetId, or model",
    });
  }

  let secretHitCount = 0;
  for (const hit of findSecretHits(raw)) {
    secretHitCount += 1;
    addError(errors, repoRoot, filePath, {
      type: "secret-like-string",
      label: hit.label,
      message: `artifact contains secret-like string (${hit.label})`,
    });
  }

  return {
    kind: "json",
    file: rel(repoRoot, filePath),
    rows: null,
    bytes: fs.statSync(filePath).size,
    approxTokens: approxTokens(raw),
    secretHits: secretHitCount,
    errors,
  };
}

export function checkModelData(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const inputPaths = options.paths ?? [];
  const files = collectCandidateFiles(repoRoot, inputPaths);
  const summaries = [];
  const errors = [];

  for (const filePath of files) {
    if (filePath.endsWith(".jsonl")) {
      const summary = checkJsonlFile({ repoRoot, filePath });
      const metadata = checkMetadataForJsonl({
        repoRoot,
        jsonlPath: filePath,
        rowCount: summary.rows,
      });
      summary.metadataFile = metadata.metadataFile;
      summary.errors.push(...metadata.errors);
      summaries.push(summary);
      errors.push(...summary.errors);
    } else {
      const summary = checkJsonArtifact({ repoRoot, filePath });
      summaries.push(summary);
      errors.push(...summary.errors);
    }
  }

  const totals = summaries.reduce(
    (acc, summary) => {
      acc.files += 1;
      acc.bytes += summary.bytes;
      acc.approxTokens += summary.approxTokens;
      acc.rows += summary.rows ?? 0;
      acc.secretHits += summary.secretHits;
      if (summary.kind === "jsonl") acc.jsonlFiles += 1;
      if (summary.kind === "json") acc.jsonFiles += 1;
      return acc;
    },
    {
      files: 0,
      jsonlFiles: 0,
      jsonFiles: 0,
      rows: 0,
      bytes: 0,
      approxTokens: 0,
      secretHits: 0,
    },
  );

  return {
    ok: errors.length === 0,
    checkedFiles: summaries.map((summary) => summary.file),
    errorCount: errors.length,
    totals,
    files: summaries,
    errors,
  };
}

function printHuman(result) {
  const status = result.ok ? "PASS" : "FAIL";
  const summary = `files=${result.totals.files} jsonl=${result.totals.jsonlFiles} json=${result.totals.jsonFiles} rows=${result.totals.rows} bytes=${result.totals.bytes} approxTokens=${result.totals.approxTokens}`;
  const write = result.ok ? console.log : console.error;
  write(`[model-data-gate] ${status} ${summary}`);

  for (const file of result.files) {
    const rowText = file.rows === null ? "" : ` rows=${file.rows}`;
    const metadataText = file.metadataFile
      ? ` metadata=${file.metadataFile}`
      : "";
    write(
      `- ${file.file} kind=${file.kind}${rowText} bytes=${file.bytes} approxTokens=${file.approxTokens}${metadataText}`,
    );
  }

  if (!result.ok) {
    for (const error of result.errors) {
      const where = error.line ? `${error.file}:${error.line}` : error.file;
      console.error(`  ! ${where} ${error.message}`);
    }
  }
}

function parseArgs(argv) {
  const args = {
    json: false,
    repoRoot: process.env.MODEL_DATA_GATE_REPO_ROOT,
    paths: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--repo-root") {
      args.repoRoot = argv[++i];
    } else if (arg.startsWith("--repo-root=")) {
      args.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--path") {
      args.paths.push(argv[++i]);
    } else if (arg.startsWith("--path=")) {
      args.paths.push(arg.slice("--path=".length));
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else {
      args.paths.push(arg);
    }
  }

  return args;
}

function usage() {
  return `Usage: node scripts/launch-qa/check-model-data.mjs [--json] [--repo-root <path>] [--path <file-or-dir> ...]

Validates app-training JSONL datasets and trajectory/fine-tune artifacts offline.
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    const result = checkModelData({
      repoRoot: args.repoRoot,
      paths: args.paths.filter(Boolean),
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHuman(result);
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(
      `[model-data-gate] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
