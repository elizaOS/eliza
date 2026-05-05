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
    reason: "actions must parse TOON with parseToonKeyValue",
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
  if (compressed.length > 160) {
    violations.push(
      `${label}: compressed description is ${compressed.length} chars (max 160)`,
    );
  }
  if (/\s{2,}|\n|\r|\t/.test(compressed)) {
    violations.push(
      `${label}: compressed description is not whitespace-normalized`,
    );
  }
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

      items.forEach((item, index) => {
        itemCount += 1;
        const name =
          item && typeof item === "object" && typeof item.name === "string"
            ? item.name
            : `#${index}`;
        const label = `${relativePath}:${group.kind}:${name}`;
        validateCompressedDoc(item, label, violations);

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
  const promptResult = auditPromptFormats();
  const actionXmlResult = auditActionXmlUsage();
  const legacyXmlResult = auditLegacyLlmXmlHelpers();
  const violations = [
    ...specResult.violations,
    ...promptResult.violations,
    ...actionXmlResult.violations,
    ...legacyXmlResult.violations,
  ];

  console.log(
    `[prompt-compliance] specs: ${specResult.itemCount} docs, ${specResult.parameterCount} params`,
  );
  console.log(
    `[prompt-compliance] prompt lines scanned: ${promptResult.scannedLineCount}`,
  );
  console.log(
    `[prompt-compliance] action XML scan: ${actionXmlResult.fileCount} files, ${actionXmlResult.scannedLineCount} lines`,
  );
  console.log(
    `[prompt-compliance] legacy LLM XML helper scan: ${legacyXmlResult.fileCount} files, ${legacyXmlResult.scannedLineCount} lines`,
  );

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
