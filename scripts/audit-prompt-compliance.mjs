#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compressPromptDescription } from "../packages/prompts/scripts/prompt-compression.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const SPEC_GROUPS = [
  {
    kind: "action",
    root: "packages/prompts/specs/actions",
    collectionKey: "actions",
    requireParameters: true,
  },
  {
    kind: "provider",
    root: "packages/prompts/specs/providers",
    collectionKey: "providers",
  },
  {
    kind: "evaluator",
    root: "packages/prompts/specs/evaluators",
    collectionKey: "evaluators",
  },
];

const PROMPT_SCAN_FILES = [
  "packages/core/src/prompts.ts",
  "packages/core/src/services/message.ts",
];

const PROMPT_SCAN_DIRS = ["packages/prompts/prompts"];

const STRUCTURED_FORMAT_ALLOWLIST = [];

const ACTION_SOURCE_ROOTS = ["packages", "plugins"];
const ACTION_SOURCE_PATH_PATTERN = /(^|\/)actions(\/|\.tsx?$)/;
const TEST_SOURCE_PATH_PATTERN =
  /(^|\/)(__tests__|tests?|e2e)(\/|$)|\.(test|spec)\.tsx?$/;
const SKIP_SCAN_DIR_NAMES = new Set([
  ".git",
  ".turbo",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const DESCRIPTION_COMPRESSED_ONLY = process.argv.includes(
  "--description-compressed-only",
);

const COMPRESSED_DESCRIPTION_MAX_LENGTH = 160;
const STRICT_COMPRESSED_SOURCE_ROOTS = [
  "plugins/plugin-calendly",
  "plugins/plugin-minecraft",
  "plugins/plugin-roblox",
  "plugins/plugin-wallet/src/analytics/birdeye",
  "plugins/plugin-mysticism",
];
const GENERATED_COMPRESSED_SOURCE_ROOTS = ["packages/core/src/generated"];

const COMPRESSED_FILLER_PATTERNS = [
  /\bthis action\b/i,
  /\ballows? users?\b/i,
  /\bused to\b/i,
  /\bsimply\b/i,
  /\bcurrently\b/i,
];

const COMPRESSED_UNGRAMMATICAL_PATTERNS = [
  /\bcannot undone\b/i,
  /\bperform Ching\b/i,
  /\bread (?:service|session|process)\b/i,
  /\breceive current\b/i,
  /\bchange line\b/i,
  /\bGoogle Meet meet\b/i,
  /\broom ID alia\b/i,
  /\brelat(?:e|ed)? message\b/i,
];

const KEYWORD_SOUP_CONNECTORS =
  /\b(?:to|for|with|by|from|in|on|via|as|when|after|before|into|using|or|and|of|the|a|an|if|at|about|through|across|without|within|requires?|returns?|only|per)\b/i;

const SEMANTIC_ROUTING_TERMS = [
  { name: "chain", pattern: /\b(?:chain|chains|chainId|chain=|chain:|blockchain)\b/i },
  { name: "category", pattern: /\bcategor(?:y|ies)\b/i },
  { name: "connector", pattern: /\bconnectors?\b/i },
  { name: "source", pattern: /\bsources?\b/i },
  { name: "subaction", pattern: /\bsubactions?\b/i },
  {
    name: "live",
    pattern: /\blive\s+(?:preview|refresh|data|operation|read|write|search|urls?)\b/i,
  },
  {
    name: "read",
    pattern: /\b(?:read-only|public-read|read\/write|read access|read,\s*type)\b/i,
  },
  {
    name: "write",
    pattern: /\b(?:write access|read\/write|write mode|write operation)\b/i,
  },
];

const FORMAT_INSTRUCTION_PATTERNS = [
  /\bReturn\s+(?:ONLY\s+|only\s+|strict\s+|valid\s+)*(?:JSON|XML)\b/i,
  /\bReturn\s+(?:JSON|XML)\s+or\s+(?:JSON|XML)\b/i,
  /\bRespond with\s+(?:ONLY\s+|only\s+|strict\s+|valid\s+)*(?:JSON|XML)\b/i,
  /\bOutput\s+(?:ONLY\s+|only\s+|strict\s+|valid\s+)*(?:JSON|XML)\b/i,
  /\bvalid\s+(?:JSON|XML)\s+only\b/i,
  /\b(?:JSON|XML)\s+only\b/i,
];

const NEGATED_FORMAT_PATTERN =
  /\b(?:do not|don't|no|without)\b[^\n]*(?:JSON|XML)|(?:JSON|XML)[^\n]*\b(?:not allowed|forbidden)\b/i;

const ACTION_XML_PATTERNS = [
  {
    pattern: /\bparseKeyValueXml\b/,
    reason: "actions must use native tool calling and JSON, not legacy XML helpers",
  },
  {
    pattern:
      /\b(?:extractXmlChildren|parseXml|parseXML|fromXml|fromXML|xmlTo[A-Z_]?|XMLTo[A-Z_]?|toXml|toXML)\b/,
    reason: "actions must not use XML parser helpers",
  },
  {
    pattern: /\bXML\b|\bxml\b/,
    reason: "actions must not mention XML as their response contract",
  },
  {
    pattern:
      /<\/?(?:response|action|actions|params|param|message|text|thought|result)(?:\s|>|\/)/,
    reason: "actions must not include XML response tag contracts",
  },
];

const LEGACY_LLM_XML_HELPER_PATTERNS = [
  {
    pattern: /\bparseKeyValueXml\b/,
    reason: "legacy XML structured-output parser must not be used or exported",
  },
  {
    pattern:
      /\b(?:findFirstXmlBlock|extractDirectChildren|parseXmlItems|XmlTagExtractor|ResponseStreamExtractor|ValidationStreamExtractor|extractXmlParams|parseSimpleXml|extractXmlTag|buildXmlResponse|compactXmlActionsBlock)\b/,
    reason: "legacy LLM XML parser/helper must not be present",
  },
  {
    pattern: /\b(?:legacy XML|XML fallback)\b/i,
    reason: "legacy LLM XML fallback must not be present",
  },
];

function readJson(relativePath) {
  const filePath = path.join(REPO_ROOT, relativePath);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listFiles(root, predicate) {
  const absoluteRoot = path.join(REPO_ROOT, root);
  const out = [];
  const stack = [absoluteRoot];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir || !fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_SCAN_DIR_NAMES.has(entry.name)) {
          continue;
        }
        stack.push(full);
        continue;
      }
      if (entry.isFile() && predicate(full)) {
        out.push(path.relative(REPO_ROOT, full));
      }
    }
  }

  return out.sort((a, b) => a.localeCompare(b));
}

function listJsonFiles(root) {
  return listFiles(root, (filePath) => filePath.endsWith(".json"));
}

function getCompressedAlias(doc) {
  if (
    typeof doc.descriptionCompressed === "string" &&
    doc.descriptionCompressed.trim()
  ) {
    return doc.descriptionCompressed.trim();
  }
  if (
    typeof doc.compressedDescription === "string" &&
    doc.compressedDescription.trim()
  ) {
    return doc.compressedDescription.trim();
  }
  return "";
}

function getNormalizedCompressed(doc) {
  const alias = getCompressedAlias(doc);
  if (alias) return alias;
  return typeof doc.description === "string"
    ? compressPromptDescription(doc.description)
    : "";
}

function normalizeCompressedKey(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hasKeywordSoupShape(compressed) {
  const words = compressed.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? [];
  if (words.length < 7) return false;
  if (/[.,;:()/-]/.test(compressed)) return false;
  return !KEYWORD_SOUP_CONNECTORS.test(compressed);
}

function validateCompressedQuality(
  compressed,
  description,
  label,
  violations,
  options = {},
) {
  const { strictGrammar = false } = options;

  for (const pattern of COMPRESSED_FILLER_PATTERNS) {
    if (pattern.test(compressed)) {
      violations.push(
        `${label}: compressed description contains filler "${pattern.source}"`,
      );
      break;
    }
  }

  if (strictGrammar && hasKeywordSoupShape(compressed)) {
    violations.push(
      `${label}: compressed description looks like keyword soup; use a compact grammatical phrase`,
    );
  }

  if (strictGrammar) {
    for (const pattern of COMPRESSED_UNGRAMMATICAL_PATTERNS) {
      if (pattern.test(compressed)) {
        violations.push(
          `${label}: compressed description looks ungrammatical (${pattern.source})`,
        );
        break;
      }
    }
  }

  if (typeof description === "string" && description.trim()) {
    for (const { name, pattern } of SEMANTIC_ROUTING_TERMS) {
      if (name === "chain" && /\bchain of actions\b/i.test(description)) {
        continue;
      }
      if (pattern.test(description) && !pattern.test(compressed)) {
        violations.push(
          `${label}: compressed description dropped semantic routing term "${name}"`,
        );
      }
    }
  }
}

function validateCompressedDoc(doc, label, violations) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    violations.push(`${label}: entry must be an object`);
    return;
  }

  if (typeof doc.name !== "string" || !doc.name.trim()) {
    violations.push(`${label}: missing name`);
  }
  if (typeof doc.description !== "string" || !doc.description.trim()) {
    violations.push(`${label}: missing description`);
  }

  if (
    typeof doc.descriptionCompressed === "string" &&
    typeof doc.compressedDescription === "string" &&
    doc.descriptionCompressed !== doc.compressedDescription
  ) {
    violations.push(
      `${label}: descriptionCompressed and compressedDescription aliases differ`,
    );
  }

  const compressed = getNormalizedCompressed(doc);
  if (!compressed) {
    violations.push(
      `${label}: missing compressed description after normalization`,
    );
    return;
  }
  if (compressed.length > COMPRESSED_DESCRIPTION_MAX_LENGTH) {
    violations.push(
      `${label}: compressed description is ${compressed.length} chars (max ${COMPRESSED_DESCRIPTION_MAX_LENGTH})`,
    );
  }
  if (/\s{2,}|\n|\r|\t/.test(compressed)) {
    violations.push(
      `${label}: compressed description is not whitespace-normalized`,
    );
  }
  validateCompressedQuality(
    compressed,
    typeof doc.description === "string" ? doc.description : "",
    label,
    violations,
  );
}

function auditSpecs() {
  const violations = [];
  let itemCount = 0;
  let parameterCount = 0;

  for (const group of SPEC_GROUPS) {
    for (const relativePath of listJsonFiles(group.root)) {
      const root = readJson(relativePath);
      const items = root[group.collectionKey];
      if (!Array.isArray(items)) {
        violations.push(
          `${relativePath}: missing ${group.collectionKey} array`,
        );
        continue;
      }

      const duplicateDescriptions = new Map();
      items.forEach((item, index) => {
        itemCount += 1;
        const name =
          item && typeof item === "object" && typeof item.name === "string"
            ? item.name
            : `#${index}`;
        const label = `${relativePath}:${group.kind}:${name}`;
        validateCompressedDoc(item, label, violations);
        const compressed = getNormalizedCompressed(item);
        const duplicateKey = normalizeCompressedKey(compressed);
        if (duplicateKey.length >= 24) {
          const existing = duplicateDescriptions.get(duplicateKey);
          if (existing) {
            violations.push(
              `${label}: duplicates compressed description from ${existing}`,
            );
          } else {
            duplicateDescriptions.set(duplicateKey, label);
          }
        }

        if (group.requireParameters && Array.isArray(item?.parameters)) {
          item.parameters.forEach((param, paramIndex) => {
            parameterCount += 1;
            const paramName =
              param &&
              typeof param === "object" &&
              typeof param.name === "string"
                ? param.name
                : `#${paramIndex}`;
            validateCompressedDoc(
              param,
              `${label}:parameter:${paramName}`,
              violations,
            );
          });
        }
      });
    }
  }

  return { violations, itemCount, parameterCount };
}

function listPromptFiles() {
  const files = new Set(PROMPT_SCAN_FILES);
  for (const dir of PROMPT_SCAN_DIRS) {
    for (const file of listFiles(dir, (filePath) =>
      filePath.endsWith(".txt"),
    )) {
      files.add(file);
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

function listActionSourceFiles() {
  const files = new Set();
  for (const root of ACTION_SOURCE_ROOTS) {
    for (const file of listFiles(root, (filePath) => {
      const relativePath = path.relative(REPO_ROOT, filePath);
      return (
        /\.(?:ts|tsx)$/.test(relativePath) &&
        ACTION_SOURCE_PATH_PATTERN.test(relativePath) &&
        !TEST_SOURCE_PATH_PATTERN.test(relativePath)
      );
    })) {
      files.add(file);
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

function listCompressedSourceFiles() {
  const files = [];
  const sourceRoots = STRICT_COMPRESSED_SOURCE_ROOTS.map((root) => ({
    root,
    strictGrammar: true,
  })).concat(
    GENERATED_COMPRESSED_SOURCE_ROOTS.map((root) => ({
      root,
      strictGrammar: false,
    })),
  );

  for (const { root, strictGrammar } of sourceRoots) {
    for (const file of listFiles(root, (filePath) => {
      const relativePath = path.relative(REPO_ROOT, filePath);
      return (
        /\.(?:ts|tsx)$/.test(relativePath) &&
        !TEST_SOURCE_PATH_PATTERN.test(relativePath)
      );
    })) {
      files.push({ file, strictGrammar });
    }
  }

  return files.sort((a, b) => a.file.localeCompare(b.file));
}

function parseStringLiteral(raw) {
  const quote = raw[0];
  const body = raw.slice(1, -1);
  if (quote === '"') {
    return JSON.parse(raw);
  }
  return body
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\`/g, "`")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function extractCompressedStringLiterals(source) {
  const entries = [];
  const pattern =
    /descriptionCompressed\s*:\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)(?:\s*\+\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`))*)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const rawInitializer = match[1];
    const literals =
      rawInitializer.match(
        /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
      ) ?? [];
    const value = literals.map(parseStringLiteral).join("");
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    entries.push({ value, line });
  }
  return entries;
}

function auditSourceCompressedDescriptions() {
  const violations = [];
  let fileCount = 0;
  let descriptionCount = 0;

  for (const { file, strictGrammar } of listCompressedSourceFiles()) {
    const absolutePath = path.join(REPO_ROOT, file);
    if (!fs.existsSync(absolutePath)) continue;
    fileCount += 1;
    const source = fs.readFileSync(absolutePath, "utf8");
    for (const { value, line } of extractCompressedStringLiterals(source)) {
      descriptionCount += 1;
      const label = `${file}:${line}:descriptionCompressed`;
      const compressed = value.trim();
      if (!compressed) {
        violations.push(`${label}: compressed description is empty`);
        continue;
      }
      if (compressed.length > COMPRESSED_DESCRIPTION_MAX_LENGTH) {
        violations.push(
          `${label}: compressed description is ${compressed.length} chars (max ${COMPRESSED_DESCRIPTION_MAX_LENGTH})`,
        );
      }
      if (/\s{2,}|\n|\r|\t/.test(compressed)) {
        violations.push(
          `${label}: compressed description is not whitespace-normalized`,
        );
      }
      validateCompressedQuality(compressed, "", label, violations, {
        strictGrammar,
      });
    }
  }

  return { violations, fileCount, descriptionCount };
}

function auditPromptFormats() {
  const violations = [];
  const usedAllowlist = new Set();
  let scannedLineCount = 0;

  for (const file of listPromptFiles()) {
    const absolutePath = path.join(REPO_ROOT, file);
    if (!fs.existsSync(absolutePath)) continue;
    const lines = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      scannedLineCount += 1;
      if (NEGATED_FORMAT_PATTERN.test(line)) return;
      if (!FORMAT_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(line))) {
        return;
      }

      const allowlistIndex = STRUCTURED_FORMAT_ALLOWLIST.findIndex(
        (entry) => entry.file === file && line.includes(entry.match),
      );
      if (allowlistIndex >= 0) {
        usedAllowlist.add(allowlistIndex);
        return;
      }

      violations.push(
        `${file}:${index + 1}: model-facing JSON/XML instruction is not allowlisted: ${line.trim()}`,
      );
    });
  }

  STRUCTURED_FORMAT_ALLOWLIST.forEach((entry, index) => {
    if (!usedAllowlist.has(index)) {
      violations.push(
        `allowlist:${entry.file}: unused structured-format allowlist entry "${entry.match}" (${entry.reason})`,
      );
    }
  });

  return { violations, scannedLineCount };
}

function auditActionXmlUsage() {
  const violations = [];
  let scannedLineCount = 0;
  let fileCount = 0;

  for (const file of listActionSourceFiles()) {
    const absolutePath = path.join(REPO_ROOT, file);
    if (!fs.existsSync(absolutePath)) continue;
    fileCount += 1;
    const lines = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      scannedLineCount += 1;
      for (const { pattern, reason } of ACTION_XML_PATTERNS) {
        if (!pattern.test(line)) continue;
        violations.push(
          `${file}:${index + 1}: ${reason}: ${line.trim()}`,
        );
      }
    });
  }

  return { violations, fileCount, scannedLineCount };
}

function listSourceFilesForLegacyXmlScan() {
  return listFiles(
    "packages",
    (filePath) =>
      /\.(?:ts|tsx|mjs)$/.test(filePath) &&
      !TEST_SOURCE_PATH_PATTERN.test(path.relative(REPO_ROOT, filePath)),
  ).concat(
    listFiles(
      "plugins",
      (filePath) =>
        /\.(?:ts|tsx|mjs)$/.test(filePath) &&
        !TEST_SOURCE_PATH_PATTERN.test(path.relative(REPO_ROOT, filePath)),
    ),
  );
}

function auditLegacyLlmXmlHelpers() {
  const violations = [];
  let scannedLineCount = 0;
  let fileCount = 0;

  for (const file of listSourceFilesForLegacyXmlScan()) {
    const absolutePath = path.join(REPO_ROOT, file);
    if (!fs.existsSync(absolutePath)) continue;
    fileCount += 1;
    const lines = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      scannedLineCount += 1;
      for (const { pattern, reason } of LEGACY_LLM_XML_HELPER_PATTERNS) {
        if (!pattern.test(line)) continue;
        violations.push(`${file}:${index + 1}: ${reason}: ${line.trim()}`);
      }
    });
  }

  return { violations, fileCount, scannedLineCount };
}

function main() {
  const specResult = auditSpecs();
  const sourceCompressedResult = auditSourceCompressedDescriptions();
  const promptResult = DESCRIPTION_COMPRESSED_ONLY
    ? { violations: [], scannedLineCount: 0 }
    : auditPromptFormats();
  const actionXmlResult = DESCRIPTION_COMPRESSED_ONLY
    ? { violations: [], fileCount: 0, scannedLineCount: 0 }
    : auditActionXmlUsage();
  const legacyXmlResult = DESCRIPTION_COMPRESSED_ONLY
    ? { violations: [], fileCount: 0, scannedLineCount: 0 }
    : auditLegacyLlmXmlHelpers();
  const violations = [
    ...specResult.violations,
    ...sourceCompressedResult.violations,
    ...promptResult.violations,
    ...actionXmlResult.violations,
    ...legacyXmlResult.violations,
  ];

  console.log(
    `[prompt-compliance] specs: ${specResult.itemCount} docs, ${specResult.parameterCount} params`,
  );
  console.log(
    `[prompt-compliance] compressed source scan: ${sourceCompressedResult.fileCount} files, ${sourceCompressedResult.descriptionCount} descriptions`,
  );
  if (!DESCRIPTION_COMPRESSED_ONLY) {
    console.log(
      `[prompt-compliance] prompt lines scanned: ${promptResult.scannedLineCount}`,
    );
    console.log(
      `[prompt-compliance] action XML scan: ${actionXmlResult.fileCount} files, ${actionXmlResult.scannedLineCount} lines`,
    );
    console.log(
      `[prompt-compliance] legacy LLM XML helper scan: ${legacyXmlResult.fileCount} files, ${legacyXmlResult.scannedLineCount} lines`,
    );
  }

  if (violations.length > 0) {
    console.error(`[prompt-compliance] ${violations.length} violation(s):`);
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log("[prompt-compliance] ok");
}

main();
