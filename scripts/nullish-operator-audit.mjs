#!/usr/bin/env node
/**
 * Audit and optionally remove unnecessary nullish/truthiness operators.
 *
 * This script inventories AST occurrences of:
 *   - non-null assertions: value!
 *   - definite assignment assertions: field!: Type
 *   - optional declarations: field?: Type / param?: Type
 *   - optional chains: value?.x / value?.[x] / value?.()
 *   - binary fallbacks/guards: ??, ||, &&
 *
 * It auto-applies only the checker-obvious cases whose removal preserves the
 * same type surface:
 *   - value! when value's type excludes null and undefined
 *   - value?.x / value?.[x] / value?.() when the receiver excludes null/undefined
 *   - lhs ?? rhs when lhs excludes null/undefined
 *
 * Usage:
 *   node scripts/nullish-operator-audit.mjs --json
 *   node scripts/nullish-operator-audit.mjs --json --roots=plugins/app-lifeops
 *   node scripts/nullish-operator-audit.mjs --json --type-aware --roots=plugins/app-lifeops
 *   node scripts/nullish-operator-audit.mjs --apply --roots=packages/core
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT_MD = path.join(ROOT, "scripts", "nullish-operator-audit.md");
const OUTPUT_JSON = path.join(ROOT, "scripts", "nullish-operator-audit.json");

const args = process.argv.slice(2);
const JSON_FLAG = args.includes("--json");
const APPLY = args.includes("--apply");
const TYPE_AWARE = args.includes("--type-aware") || APPLY;
const PROGRESS = args.includes("--progress");
const INCLUDE_TESTS = !args.includes("--production") && !args.includes("--no-tests");
const MAX_APPLY = Number(readArg("--max-apply") ?? Number.POSITIVE_INFINITY);
const TSCONFIG = path.resolve(ROOT, readArg("--tsconfig") ?? "tsconfig.json");
const ROOT_ARGS = readArg("--roots")
  ?.split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const DEFAULT_ROOTS = ["src", "packages", "plugins", "cloud", "apps"];
const SCAN_ROOTS = (ROOT_ARGS?.length ? ROOT_ARGS : DEFAULT_ROOTS)
  .map((entry) => path.resolve(ROOT, entry))
  .filter((entry) => fs.existsSync(entry));

const IGNORED_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp",
]);

const TEST_FILE_PATTERN =
  /(?:^|\/)(?:__tests__|__mocks__|test|tests|e2e|fixtures|fixture)(?:\/|$)|\.(?:test|spec|e2e|stories)\.(?:ts|tsx)$/;

function readArg(name) {
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replaceAll(path.sep, "/");
}

function markdownEscape(value) {
  return String(value).replaceAll("|", "\\|");
}

function collectFiles(roots) {
  const files = [];
  for (const root of roots) walk(root, files);
  return files.sort((a, b) => relative(a).localeCompare(relative(b)));
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), acc);
      continue;
    }

    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) {
      continue;
    }

    const full = path.join(dir, entry.name);
    const rel = relative(full);
    if (!INCLUDE_TESTS && TEST_FILE_PATTERN.test(rel)) continue;
    acc.push(full);
  }
}

function loadCompilerOptions() {
  const fallback = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    noEmit: true,
  };

  if (!fs.existsSync(TSCONFIG)) return fallback;

  const read = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  if (read.error) {
    console.warn(formatDiagnostic(read.error));
    return fallback;
  }

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(TSCONFIG),
    { noEmit: true, skipLibCheck: true },
    TSCONFIG,
  );

  if (parsed.errors.length) {
    for (const error of parsed.errors) console.warn(formatDiagnostic(error));
  }

  return {
    ...parsed.options,
    strict: true,
    strictNullChecks: true,
  };
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function typeText(checker, type) {
  if (!checker || !type) return "";
  try {
    return checker.typeToString(type);
  } catch {
    return "(unprintable)";
  }
}

function apparentType(checker, node) {
  if (!checker) return undefined;
  try {
    return checker.getTypeAtLocation(node);
  } catch {
    return undefined;
  }
}

function typeParts(type) {
  if (!type) return [];
  return type.isUnion?.() ? type.types : [type];
}

function includesNullish(type) {
  if (!type) return true;
  return typeParts(type).some((part) => {
    const flags = part.flags;
    return (
      (flags & ts.TypeFlags.Null) !== 0 ||
      (flags & ts.TypeFlags.Undefined) !== 0 ||
      (flags & ts.TypeFlags.Void) !== 0 ||
      (flags & ts.TypeFlags.Any) !== 0 ||
      (flags & ts.TypeFlags.Unknown) !== 0
    );
  });
}

function isDefinitelyTruthyType(type) {
  if (!type) return false;
  return typeParts(type).every((part) => {
    const flags = part.flags;
    if ((flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) {
      return false;
    }
    if ((flags & ts.TypeFlags.BooleanLiteral) !== 0) return part.intrinsicName === "true";
    if ((flags & ts.TypeFlags.StringLiteral) !== 0) return part.value !== "";
    if ((flags & ts.TypeFlags.NumberLiteral) !== 0) return part.value !== 0;
    if ((flags & ts.TypeFlags.BigIntLiteral) !== 0) return part.value?.base10Value !== "0";
    if ((flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.BigInt | ts.TypeFlags.Boolean)) !== 0) {
      return false;
    }
    return true;
  });
}

function containsUncheckedElementAccess(node) {
  let found = false;
  function visit(current) {
    if (found) return;
    if (ts.isElementAccessExpression(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function lineAndColumn(sf, nodeOrPos) {
  const pos =
    typeof nodeOrPos === "number" ? nodeOrPos : nodeOrPos.getStart(sf);
  const position = sf.getLineAndCharacterOfPosition(pos);
  return { line: position.line + 1, column: position.character + 1 };
}

function snippet(sf, node) {
  return node.getText(sf).replace(/\s+/g, " ").slice(0, 180);
}

function makeRecord(sf, checker, kind, node, details) {
  const { line, column } = lineAndColumn(sf, details.pos ?? node);
  return {
    id: `${relative(sf.fileName)}:${line}:${column}:${kind}`,
    kind,
    file: relative(sf.fileName),
    line,
    column,
    classification: details.classification,
    reason: details.reason,
    type: details.type ?? "",
    text: details.text ?? snippet(sf, node),
    edit: details.edit ?? null,
  };
}

function replacementEdit(sf, start, end, replacement) {
  return {
    file: relative(sf.fileName),
    start,
    end,
    startLine: lineAndColumn(sf, start).line,
    replacement,
  };
}

function binaryOperatorText(kind) {
  if (kind === ts.SyntaxKind.QuestionQuestionToken) return "??";
  if (kind === ts.SyntaxKind.BarBarToken) return "||";
  if (kind === ts.SyntaxKind.AmpersandAmpersandToken) return "&&";
  return "";
}

function parseSourceFiles(files) {
  return files.map((file) => {
    const source = fs.readFileSync(file, "utf8");
    return ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  });
}

function collectCandidates(sourceFiles, files, checker) {
  const wanted = new Set(files.map((file) => path.resolve(file)));
  const records = [];

  for (const sf of sourceFiles) {
    if (sf.isDeclarationFile || !wanted.has(path.resolve(sf.fileName))) continue;

    function visit(node) {
      if (ts.isNonNullExpression(node)) {
        const operandType = apparentType(checker, node.expression);
        const removable = checker ? !includesNullish(operandType) : false;
        records.push(
          makeRecord(sf, checker, "non-null-assertion", node, {
            classification: checker
              ? removable
                ? "type-obvious-removable"
                : "type-required-or-unknown"
              : "syntax-inventory",
            reason: checker
              ? removable
              ? "operand type excludes null and undefined"
                : "operand type includes null/undefined/any/unknown"
              : "run with --type-aware to classify by TypeScript types",
            type: typeText(checker, operandType),
            edit: removable
              ? replacementEdit(
                  sf,
                  node.getStart(sf),
                  node.getEnd(),
                  sf.text.slice(node.expression.getStart(sf), node.expression.getEnd()),
                )
              : null,
          }),
        );
      }

      const questionDotToken = node.questionDotToken;
      if (
        questionDotToken &&
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node) ||
          ts.isCallExpression(node))
      ) {
        const receiver = ts.isCallExpression(node) ? node.expression : node.expression;
        const receiverType = apparentType(checker, receiver);
        const uncheckedIndex = containsUncheckedElementAccess(receiver);
        const removable = checker ? !uncheckedIndex && !includesNullish(receiverType) : false;
        let edit = null;
        if (removable) {
          const tokenStart = questionDotToken.getStart(sf);
          const tokenEnd = questionDotToken.getEnd();
          const replacement = ts.isElementAccessExpression(node) ? "" : ".";
          edit = replacementEdit(sf, tokenStart, tokenEnd, replacement);
        }
        records.push(
          makeRecord(sf, checker, "optional-chain", node, {
            pos: questionDotToken.getStart(sf),
            classification: checker
              ? removable
                ? "type-obvious-removable"
                : "type-required-or-unknown"
              : "syntax-inventory",
            reason: checker
              ? uncheckedIndex
                ? "receiver includes indexed access; noUncheckedIndexedAccess is not required here"
                : removable
              ? "receiver type excludes null and undefined"
                : "receiver type includes null/undefined/any/unknown"
              : "run with --type-aware to classify by TypeScript types",
            type: typeText(checker, receiverType),
            edit,
          }),
        );
      }

      if (ts.isPropertyDeclaration(node) && node.exclamationToken) {
        records.push(
          makeRecord(sf, checker, "definite-assignment-assertion", node, {
            pos: node.exclamationToken.getStart(sf),
            classification: "review-required",
            reason: "class field initialization requires control-flow review",
          }),
        );
      }

      if (
        (ts.isPropertySignature(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isParameter(node) ||
          ts.isMethodSignature(node) ||
          ts.isMethodDeclaration(node)) &&
        node.questionToken
      ) {
        records.push(
          makeRecord(sf, checker, "optional-declaration", node, {
            pos: node.questionToken.getStart(sf),
            classification: "upstream-type-review",
            reason: "optional surface may require callers or implementers to change",
          }),
        );
      }

      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      ) {
        const op = binaryOperatorText(node.operatorToken.kind);
        const leftType = apparentType(checker, node.left);
        let classification = "review-required";
        let reason = `${op} has runtime truthiness/control-flow semantics`;
        let edit = null;

        if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
          const uncheckedIndex = containsUncheckedElementAccess(node.left);
          const removable = checker ? !uncheckedIndex && !includesNullish(leftType) : false;
          classification = checker
            ? removable
              ? "type-obvious-removable"
              : "type-required-or-unknown"
            : "syntax-inventory";
          reason = checker
            ? uncheckedIndex
              ? "left-hand side includes indexed access; noUncheckedIndexedAccess is not required here"
              : removable
              ? "left-hand type excludes null and undefined"
              : "left-hand type includes null/undefined/any/unknown"
            : "run with --type-aware to classify by TypeScript types";
          edit = removable
            ? replacementEdit(
                sf,
                node.getStart(sf),
                node.getEnd(),
                sf.text.slice(node.left.getStart(sf), node.left.getEnd()),
              )
            : null;
        } else if (checker && isDefinitelyTruthyType(leftType)) {
          classification = "truthy-left-review";
          reason = "left-hand type appears always truthy, but removal may drop side effects";
        }

        records.push(
          makeRecord(sf, checker, `binary-${op}`, node, {
            pos: node.operatorToken.getStart(sf),
            classification,
            reason,
            type: typeText(checker, leftType),
            edit,
          }),
        );
      }

      ts.forEachChild(node, visit);
    }

    visit(sf);
  }

  return records;
}

function collectSyntaxCandidates(files) {
  const records = [];
  for (let index = 0; index < files.length; index++) {
    if (PROGRESS && index > 0 && index % 500 === 0) {
      console.error(`Parsed ${index}/${files.length} files...`);
    }
    const sf = parseSourceFiles([files[index]])[0];
    records.push(...collectCandidates([sf], [files[index]], null));
  }
  return records;
}

function groupCounts(records, key) {
  const counts = new Map();
  for (const record of records) counts.set(record[key], (counts.get(record[key]) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function applyEdits(records) {
  const candidates = records
    .filter((record) => record.edit && record.classification === "type-obvious-removable")
    .sort((left, right) => {
      const byFile = left.edit.file.localeCompare(right.edit.file);
      if (byFile !== 0) return byFile;
      const byStart = left.edit.start - right.edit.start;
      if (byStart !== 0) return byStart;
      return right.edit.end - left.edit.end;
    });

  const editable = [];
  const lastEndByFile = new Map();
  for (const record of candidates) {
    const lastEnd = lastEndByFile.get(record.edit.file) ?? -1;
    if (record.edit.start < lastEnd) continue;
    editable.push(record);
    lastEndByFile.set(record.edit.file, record.edit.end);
    if (editable.length >= MAX_APPLY) break;
  }

  const byFile = new Map();
  for (const record of editable) {
    const edits = byFile.get(record.edit.file) ?? [];
    edits.push(record.edit);
    byFile.set(record.edit.file, edits);
  }

  for (const [rel, edits] of byFile.entries()) {
    const full = path.join(ROOT, rel);
    let text = fs.readFileSync(full, "utf8");
    edits.sort((a, b) => b.start - a.start);
    for (const edit of edits) {
      text = `${text.slice(0, edit.start)}${edit.replacement}${text.slice(edit.end)}`;
    }
    fs.writeFileSync(full, text);
  }

  return editable;
}

function renderMarkdown(payload) {
  const lines = [];
  lines.push("# Nullish Operator Audit Report", "");
  lines.push(`Generated: ${payload.generatedAt}`, "");
  lines.push("## Summary", "");
  lines.push("| Metric | Count |");
  lines.push("| --- | ---: |");
  lines.push(`| TypeScript files scanned | ${payload.summary.filesScanned} |`);
  lines.push(`| Operators found | ${payload.summary.total} |`);
  lines.push(`| Type-obvious removable | ${payload.summary.typeObviousRemovable} |`);
  lines.push(`| Applied edits | ${payload.summary.appliedEdits} |`);
  lines.push("", "## By Kind", "");
  lines.push("| Kind | Count |");
  lines.push("| --- | ---: |");
  for (const [kind, count] of Object.entries(payload.byKind)) {
    lines.push(`| \`${markdownEscape(kind)}\` | ${count} |`);
  }
  lines.push("", "## By Classification", "");
  lines.push("| Classification | Count |");
  lines.push("| --- | ---: |");
  for (const [classification, count] of Object.entries(payload.byClassification)) {
    lines.push(`| \`${markdownEscape(classification)}\` | ${count} |`);
  }

  const removable = payload.records
    .filter((record) => record.classification === "type-obvious-removable")
    .slice(0, 200);
  lines.push("", "## Type-Obvious Removable Examples", "");
  if (!removable.length) {
    lines.push("No type-obvious removable operators found.");
  } else {
    for (const record of removable) {
      lines.push(
        `- \`${record.file}:${record.line}:${record.column}\` ${record.kind}: ${markdownEscape(record.text)}`,
      );
      lines.push(`  - ${markdownEscape(record.reason)}; type: \`${markdownEscape(record.type)}\``);
    }
  }

  return `${lines.join("\n")}\n`;
}

const files = collectFiles(SCAN_ROOTS);
const compilerOptions = TYPE_AWARE ? loadCompilerOptions() : null;
const program = TYPE_AWARE ? ts.createProgram(files, compilerOptions) : null;
const checker = TYPE_AWARE ? program.getTypeChecker() : null;
const records = TYPE_AWARE
  ? collectCandidates(program.getSourceFiles(), files, checker)
  : collectSyntaxCandidates(files);
const applied = APPLY ? applyEdits(records) : [];

const payload = {
  generatedAt: new Date().toISOString(),
  roots: SCAN_ROOTS.map(relative),
  testsIncluded: INCLUDE_TESTS,
  tsconfig: relative(TSCONFIG),
  typeAware: TYPE_AWARE,
  apply: APPLY,
  summary: {
    filesScanned: files.length,
    total: records.length,
    typeObviousRemovable: records.filter(
      (record) => record.classification === "type-obvious-removable",
    ).length,
    appliedEdits: applied.length,
  },
  byKind: groupCounts(records, "kind"),
  byClassification: groupCounts(records, "classification"),
  records,
};

fs.writeFileSync(OUTPUT_MD, renderMarkdown(payload));
if (JSON_FLAG) fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`Scanned ${files.length} TypeScript files${TYPE_AWARE ? " with type information" : " with syntax-only AST parsing"}.`);
console.log(`Found ${records.length} operators; ${payload.summary.typeObviousRemovable} are type-obvious removable.`);
if (APPLY) console.log(`Applied ${applied.length} edits.`);
console.log(`Wrote ${relative(OUTPUT_MD)}${JSON_FLAG ? ` and ${relative(OUTPUT_JSON)}` : ""}.`);
