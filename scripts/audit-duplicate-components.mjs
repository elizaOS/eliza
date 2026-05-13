#!/usr/bin/env node
/**
 * Static audit for component duplication and planner-surface hygiene.
 *
 * Scans packages/ and plugins/ for Action, Provider, Evaluator, and Service
 * definitions. It is intentionally heuristic: the goal is CI-friendly
 * regression detection, with an allowlist for known intentional cases.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const DEFAULT_ROOTS = ["packages", "plugins"];
const DEFAULT_ALLOWLIST = "scripts/duplicate-component-audit.allowlist.json";
const MAX_SCAN_FILE_BYTES = 1_000_000;

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".cjs",
  ".cts",
]);
const PROMPT_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ".txt"]);

const SKIP_DIR_NAMES = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "__fixtures__",
  "assets",
  "book",
  "build",
  "coverage",
  "dist",
  "dist-mobile",
  "fixtures",
  "generated",
  "node_modules",
  "out",
  "public",
  "target",
  "tmp",
  "vendor",
]);

const TEST_PATH_PATTERN =
  /(^|\/)(__mocks__|__tests__|e2e|fixtures?|mocks?|tests?)(\/|$)|\.(?:bench|e2e|fixture|mock|spec|test)\.[cm]?[jt]sx?$/;

const NON_PRODUCTION_PATH_PATTERN =
  /(^|\/)packages\/(benchmarks|docs|examples|training)(\/|$)|(^|\/)packages\/core\/src\/testing(\/|$)|(^|\/)packages\/elizaos\/templates(\/|$)/;

const GENERATED_PATH_PATTERN =
  /(^|\/)(generated|dist|dist-mobile|build|public|assets)(\/|$)|(^|\/)types\/generated(\/|$)|(^|\/)electrobun\/build(\/|$)|(^|\/)prompts\/scripts(\/|$)/;

const COMPONENT_TYPE_PATTERNS = {
  action: /\bAction\b/,
  provider: /\bProvider\b/,
  evaluator: /\bEvaluator\b/,
};

const DUPLICATE_RULES = {
  action: "duplicate-action-name",
  provider: "duplicate-provider-name",
  evaluator: "duplicate-evaluator-name",
};

const READONLY_ACTION_PREFIXES =
  /^(CHECK|DESCRIBE|FETCH|FIND|GET|LIST|READ|SEARCH|SHOW|STATUS|VIEW)_/;
const READONLY_ACTION_SUFFIXES =
  /_(CONTEXT|HISTORY|INFO|LIST|OVERVIEW|QUEUE|STATE|STATUS|SUMMARY)$/;
const SIDE_EFFECT_ACTION_PATTERN =
  /^(ADD|APPROVE|AUTH|BUY|CANCEL|CLEAR|CLOSE|CREATE|DELETE|DOWNLOAD|EDIT|EXECUTE|JOIN|LEAVE|LOAD|MODIFY|OPEN|PAUSE|PIN|PLAY|POST|PREPARE|PUBLISH|QUEUE|REACT|REJECT|REMOVE|REPLY|RESUME|RUN|SAVE|SEND|SET|SIGN|SKIP|START|STOP|SUBMIT|TRANSFER|UPDATE|UPLOAD|WITHDRAW)_/;

const STRUCTURED_PROMPT_PATTERNS = [
  {
    kind: "format-instruction",
    pattern:
      /\bReturn\s+(?:ONLY\s+|only\s+|strict\s+|valid\s+)*(?:JSON|XML)\b/i,
  },
  {
    kind: "format-instruction",
    pattern: /\bReturn\s+(?:JSON|XML)\s+or\s+(?:JSON|XML)\b/i,
  },
  {
    kind: "format-instruction",
    pattern:
      /\bRespond with\s+(?:ONLY\s+|only\s+|strict\s+|valid\s+)*(?:JSON|XML)\b/i,
  },
  {
    kind: "format-instruction",
    pattern:
      /\bOutput\s+(?:ONLY\s+|only\s+|strict\s+|valid\s+)*(?:JSON|XML)\b/i,
  },
  {
    kind: "format-instruction",
    pattern: /\bvalid\s+(?:JSON|XML)\s+only\b/i,
  },
  {
    kind: "format-instruction",
    pattern: /\b(?:JSON|XML)\s+only\b/i,
  },
  {
    kind: "fenced-schema",
    pattern: /```(?:json|xml)\b/i,
  },
  {
    kind: "xml-contract",
    pattern:
      /<\/?(?:response|thought|action|actions|params|param|message|messages|result)(?:\s|>|\/)/,
  },
];

const NEGATED_STRUCTURED_PROMPT_PATTERN =
  /\b(?:do not|don't|no|never|without)\b[^\n]*(?:JSON|XML)|(?:JSON|XML)[^\n]*\b(?:not allowed|forbidden|instead of|avoid)\b/i;

const NON_PROMPT_JSON_PATTERN =
  /\b(?:JSON\.parse|JSON\.stringify|fenceMatch|raw\.match|response\.json|application\/json|Content-Type|schema|z\.object|type:\s*["']object["'])\b/i;

const PROMPT_LIKE_PATH_PATTERN =
  /(^|\/)(actions?|evaluators?|providers?|prompts?|templates?|planner|routers?|message|messages|services)(\/|$)|(?:prompt|template|planner|router|evaluator|provider|message)[^/]*\.[cm]?[jt]sx?$/i;

const TRAJECTORY_WRAPPER_NAMES = new Set([
  "recordLlmCall",
  "spawnWithTrajectoryLink",
  "withActionStep",
  "withEvaluatorStep",
  "withProviderStep",
]);

const RAW_GENERATION_CALLEE_NAMES = new Set(["generateObject"]);

const FETCH_GENERATION_PATTERN =
  /(chat\/completions|\/responses|\/messages|generateContent|:generateContent|anthropic|openai|openrouter|ollama|groq|vertex|xai|completion|completions)/i;

const FETCH_PAYLOAD_PATTERN = /\b(model|messages|prompt|input|contents)\b/i;

function parseArgs(argv) {
  const options = {
    allowlistPath: path.join(REPO_ROOT, DEFAULT_ALLOWLIST),
    failOn: "error",
    format: "text",
    includeTests: false,
    maxIssues: 200,
    repoRoot: REPO_ROOT,
    roots: [...DEFAULT_ROOTS],
    selfCheck: false,
  };

  for (const arg of argv) {
    if (arg === "--json" || arg === "--format=json") {
      options.format = "json";
    } else if (arg === "--strict") {
      options.failOn = "warning";
    } else if (arg === "--no-allowlist") {
      options.allowlistPath = null;
    } else if (arg === "--include-tests") {
      options.includeTests = true;
    } else if (arg === "--self-check") {
      options.selfCheck = true;
    } else if (arg.startsWith("--allowlist=")) {
      options.allowlistPath = path.resolve(
        REPO_ROOT,
        arg.slice("--allowlist=".length),
      );
    } else if (arg.startsWith("--fail-on=")) {
      const value = arg.slice("--fail-on=".length);
      if (!["error", "none", "warning"].includes(value)) {
        throw new Error(`Unsupported --fail-on value: ${value}`);
      }
      options.failOn = value;
    } else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (!["json", "text"].includes(value)) {
        throw new Error(`Unsupported --format value: ${value}`);
      }
      options.format = value;
    } else if (arg.startsWith("--max-issues=")) {
      const value = Number(arg.slice("--max-issues=".length));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`Unsupported --max-issues value: ${arg}`);
      }
      options.maxIssues = value;
    } else if (arg.startsWith("--root=")) {
      const root = arg.slice("--root=".length);
      options.roots = [root];
    } else if (arg.startsWith("--roots=")) {
      options.roots = arg
        .slice("--roots=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/audit-duplicate-components.mjs [options]

Options:
  --json | --format=json       Emit machine-readable JSON.
  --allowlist=PATH             Load allowlist entries from PATH.
  --no-allowlist               Ignore the default allowlist file.
  --fail-on=error|warning|none Set exit threshold. Default: error.
  --strict                     Alias for --fail-on=warning.
  --root=PATH                  Scan one root instead of packages,plugins.
  --roots=A,B                  Scan comma-separated roots.
  --include-tests              Include test/spec/fixture files.
  --max-issues=N               Limit text output. Default: 200.
  --self-check                 Run fixture-based self-check and exit.
`);
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function relativePath(repoRoot, filePath) {
  return toPosix(path.relative(repoRoot, filePath));
}

function isSourceFile(filePath) {
  return (
    SOURCE_EXTENSIONS.has(path.extname(filePath)) &&
    !filePath.endsWith(".d.ts") &&
    !filePath.endsWith(".min.js")
  );
}

function isPromptFile(filePath) {
  return PROMPT_EXTENSIONS.has(path.extname(filePath));
}

function shouldSkipPath(relativeFile, includeTests) {
  if (NON_PRODUCTION_PATH_PATTERN.test(relativeFile)) return true;
  if (GENERATED_PATH_PATTERN.test(relativeFile)) return true;
  if (!includeTests && TEST_PATH_PATTERN.test(relativeFile)) return true;
  return false;
}

function walkFiles(repoRoot, roots, predicate, includeTests = false) {
  const files = [];

  for (const root of roots) {
    const absoluteRoot = path.resolve(repoRoot, root);
    if (!fs.existsSync(absoluteRoot)) continue;
    const stack = [absoluteRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) continue;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const relative = relativePath(repoRoot, full);
        if (entry.isDirectory()) {
          if (SKIP_DIR_NAMES.has(entry.name)) continue;
          if (GENERATED_PATH_PATTERN.test(`${relative}/`)) continue;
          if (!includeTests && TEST_PATH_PATTERN.test(`${relative}/`)) {
            continue;
          }
          stack.push(full);
        } else if (
          entry.isFile() &&
          predicate(full) &&
          !shouldSkipPath(relative, includeTests)
        ) {
          let size = 0;
          try {
            size = fs.statSync(full).size;
          } catch {
            continue;
          }
          if (size > MAX_SCAN_FILE_BYTES) continue;
          files.push(full);
        }
      }
    }
  }

  return [...new Set(files)].sort((a, b) => a.localeCompare(b));
}

function scriptKindForFile(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function createSourceFile(filePath, text) {
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(filePath),
  );
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function tryReadText(filePath) {
  try {
    return readText(filePath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function getLine(sourceFile, nodeOrPosition) {
  const position =
    typeof nodeOrPosition === "number"
      ? nodeOrPosition
      : nodeOrPosition.getStart(sourceFile);
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function propertyNameText(name) {
  if (!name) return "";
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return name.getText();
}

function objectProperties(objectLiteral) {
  const properties = new Map();
  for (const property of objectLiteral.properties) {
    if (
      ts.isPropertyAssignment(property) ||
      ts.isMethodDeclaration(property) ||
      ts.isShorthandPropertyAssignment(property)
    ) {
      properties.set(propertyNameText(property.name), property);
    }
  }
  return properties;
}

function getObjectProperty(objectLiteral, name) {
  return objectProperties(objectLiteral).get(name);
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function literalValue(expression, constants, options = {}) {
  if (!expression) return null;
  const unwrapped = unwrapExpression(expression);
  if (
    ts.isStringLiteral(unwrapped) ||
    ts.isNoSubstitutionTemplateLiteral(unwrapped)
  ) {
    return unwrapped.text;
  }
  if (ts.isIdentifier(unwrapped)) {
    return (
      constants.get(unwrapped.text) ??
      (options.allowSymbolic ? unwrapped.text : null)
    );
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const text = unwrapped.getText();
    return constants.get(text) ?? (options.allowSymbolic ? text : null);
  }
  if (
    ts.isTemplateExpression(unwrapped) &&
    unwrapped.templateSpans.length === 0
  ) {
    return unwrapped.head.text;
  }
  return null;
}

function collectLocalConstants(sourceFile, inheritedConstants = new Map()) {
  const constants = new Map(inheritedConstants);
  const pending = [];

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      pending.push(node);
    } else if (ts.isEnumDeclaration(node)) {
      for (const member of node.members) {
        if (
          member.initializer &&
          (ts.isStringLiteral(member.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(member.initializer))
        ) {
          const memberName = propertyNameText(member.name);
          constants.set(
            `${node.name.text}.${memberName}`,
            member.initializer.text,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of pending) {
      if (constants.has(declaration.name.text) || !declaration.initializer) {
        continue;
      }
      const value = literalValue(declaration.initializer, constants);
      if (typeof value === "string") {
        constants.set(declaration.name.text, value);
        changed = true;
      }
    }
  }

  return constants;
}

function collectUniqueGlobalConstants(parsedFiles) {
  const valuesByName = new Map();

  for (const { sourceFile } of parsedFiles) {
    const constants = collectLocalConstants(sourceFile);
    for (const [name, value] of constants.entries()) {
      if (!valuesByName.has(name)) valuesByName.set(name, new Set());
      valuesByName.get(name).add(value);
    }
  }

  const unique = new Map();
  for (const [name, values] of valuesByName.entries()) {
    if (values.size === 1) {
      unique.set(name, [...values][0]);
    }
  }
  return unique;
}

function getDeclaredTypeTexts(objectLiteral) {
  const typeTexts = [];
  let current = objectLiteral;
  let parent = objectLiteral.parent;

  while (parent) {
    if (
      (ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertionExpression(parent)) &&
      parent.expression === current
    ) {
      typeTexts.push(parent.type.getText());
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      if (parent.type) typeTexts.push(parent.type.getText());
      break;
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === current) {
      break;
    }
    if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) {
      break;
    }
    current = parent;
    parent = parent.parent;
  }

  return typeTexts;
}

function getVariableName(objectLiteral) {
  let current = objectLiteral;
  let parent = objectLiteral.parent;
  while (parent) {
    if (
      (ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === current &&
      ts.isIdentifier(parent.name)
    ) {
      return parent.name.text;
    }
    break;
  }
  return "";
}

function getArrayPropertyContext(objectLiteral) {
  let current = objectLiteral;
  let parent = objectLiteral.parent;
  while (parent) {
    if (
      (ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (
      ts.isArrayLiteralExpression(parent) &&
      parent.elements.includes(current)
    ) {
      const arrayNode = parent;
      let arrayCurrent = arrayNode;
      let arrayParent = arrayNode.parent;
      while (
        arrayParent &&
        (ts.isAsExpression(arrayParent) ||
          ts.isSatisfiesExpression(arrayParent) ||
          ts.isTypeAssertionExpression(arrayParent) ||
          ts.isParenthesizedExpression(arrayParent) ||
          ts.isNonNullExpression(arrayParent)) &&
        arrayParent.expression === arrayCurrent
      ) {
        arrayCurrent = arrayParent;
        arrayParent = arrayParent.parent;
      }
      if (ts.isPropertyAssignment(arrayParent)) {
        return propertyNameText(arrayParent.name);
      }
      if (
        ts.isVariableDeclaration(arrayParent) &&
        arrayParent.type &&
        /\b(Action|Provider|Evaluator)\s*\[\]/.test(arrayParent.type.getText())
      ) {
        const text = arrayParent.type.getText();
        if (/\bAction\s*\[\]/.test(text)) return "actions";
        if (/\bProvider\s*\[\]/.test(text)) return "providers";
        if (/\bEvaluator\s*\[\]/.test(text)) return "evaluators";
      }
      break;
    }
    current = parent;
    parent = parent.parent;
  }
  return "";
}

function inferComponentKind(objectLiteral, relativeFile) {
  const properties = objectProperties(objectLiteral);
  const typeText = getDeclaredTypeTexts(objectLiteral).join(" ");
  for (const [kind, pattern] of Object.entries(COMPONENT_TYPE_PATTERNS)) {
    if (pattern.test(typeText)) return kind;
  }

  const arrayContext = getArrayPropertyContext(objectLiteral);
  if (arrayContext === "actions") return "action";
  if (arrayContext === "providers") return "provider";
  if (arrayContext === "evaluators") return "evaluator";

  if (properties.has("name") && properties.has("get")) return "provider";
  if (
    properties.has("name") &&
    properties.has("handler") &&
    properties.has("validate")
  ) {
    if (
      /(^|\/)evaluators?(\/|$)/.test(relativeFile) ||
      (properties.has("examples") && !properties.has("parameters"))
    ) {
      return "evaluator";
    }
    return "action";
  }

  return null;
}

function getPropertyValue(property, constants, options = {}) {
  if (!property) return null;
  if (ts.isPropertyAssignment(property)) {
    return literalValue(property.initializer, constants, options);
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return constants.get(property.name.text) ?? property.name.text;
  }
  return null;
}

function hasActionParameters(objectLiteral) {
  const property = getObjectProperty(objectLiteral, "parameters");
  if (!property || !ts.isPropertyAssignment(property)) return false;
  const initializer = unwrapExpression(property.initializer);
  if (initializer.kind === ts.SyntaxKind.UndefinedKeyword) return false;
  if (ts.isArrayLiteralExpression(initializer))
    return initializer.elements.length > 0;
  return true;
}

function staticStringText(node) {
  const values = [];
  function visit(child) {
    if (
      ts.isStringLiteral(child) ||
      ts.isNoSubstitutionTemplateLiteral(child)
    ) {
      values.push(child.text);
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return values.join("\n");
}

function _stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function getProviderGetSource(providerObject, sourceFile) {
  const property = getObjectProperty(providerObject, "get");
  if (!property) return "";
  return property.getText(sourceFile);
}

function getProviderGetImplementation(providerObject) {
  const property = getObjectProperty(providerObject, "get");
  if (!property) return null;
  if (ts.isMethodDeclaration(property)) return property;
  if (!ts.isPropertyAssignment(property)) return null;
  return unwrapExpression(property.initializer);
}

function isInstructionOnlyProvider(provider, sourceFile) {
  const source = provider.node.getText(sourceFile);
  const getSource = getProviderGetSource(provider.node, sourceFile);
  const textSignals = [
    provider.name,
    provider.variableName,
    provider.file,
    staticStringText(provider.node),
  ].join("\n");
  const hasInstructionSignal =
    /\b(instruction|instructions|guidance|guidelines|rules|planner|prompt|subaction|when asked|you should|you must|must use)\b/i.test(
      textSignals,
    );
  if (!hasInstructionSignal) return false;

  const dataSignalSource = getSource || source;
  if (
    /\b(?:data|values)\s*:/.test(dataSignalSource) &&
    !/\b(?:data|values)\s*:\s*\{\s*\}/.test(dataSignalSource)
  ) {
    return false;
  }
  const hasDataSignal =
    /\b(?:runtime|state|message|_runtime|_state|_message)\s*\.|getService|getMemory|getMemories|fetch\s*\(|client\s*\.|service\s*\.|database|db\s*\./i.test(
      dataSignalSource,
    );
  return !hasDataSignal;
}

function isEmptyProviderReturnExpression(expression) {
  if (!expression) return true;
  const unwrapped = unwrapExpression(expression);
  if (
    unwrapped.kind === ts.SyntaxKind.NullKeyword ||
    unwrapped.kind === ts.SyntaxKind.UndefinedKeyword
  ) {
    return true;
  }
  if (
    (ts.isStringLiteral(unwrapped) ||
      ts.isNoSubstitutionTemplateLiteral(unwrapped)) &&
    unwrapped.text.trim() === ""
  ) {
    return true;
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) return false;

  const meaningfulProperties = unwrapped.properties.filter((property) => {
    if (!ts.isPropertyAssignment(property)) return true;
    const name = propertyNameText(property.name);
    if (!["data", "text", "values"].includes(name)) return true;
    const value = unwrapExpression(property.initializer);
    if (name === "text") {
      return !(
        (ts.isStringLiteral(value) ||
          ts.isNoSubstitutionTemplateLiteral(value)) &&
        value.text.trim() === ""
      );
    }
    return !(
      ts.isObjectLiteralExpression(value) && value.properties.length === 0
    );
  });

  return meaningfulProperties.length === 0;
}

function collectReturnExpressions(node) {
  const returns = [];
  function visit(child) {
    if (
      child !== node &&
      (ts.isFunctionDeclaration(child) ||
        ts.isFunctionExpression(child) ||
        ts.isArrowFunction(child) ||
        ts.isMethodDeclaration(child) ||
        ts.isClassDeclaration(child) ||
        ts.isClassExpression(child))
    ) {
      return;
    }
    if (ts.isReturnStatement(child)) {
      returns.push(child.expression ?? null);
      return;
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return returns;
}

function isEmptyProvider(provider, _sourceFile) {
  const implementation = getProviderGetImplementation(provider.node);
  if (!implementation) return false;

  if (ts.isArrowFunction(implementation) && !ts.isBlock(implementation.body)) {
    return isEmptyProviderReturnExpression(implementation.body);
  }

  const body =
    ts.isMethodDeclaration(implementation) ||
    ts.isFunctionExpression(implementation) ||
    ts.isArrowFunction(implementation)
      ? implementation.body
      : null;
  if (!body) return false;
  const returns = collectReturnExpressions(body);
  return returns.length > 0 && returns.every(isEmptyProviderReturnExpression);
}

function shouldBeProviderByName(actionName) {
  if (!actionName) return false;
  if (SIDE_EFFECT_ACTION_PATTERN.test(actionName)) return false;
  return (
    READONLY_ACTION_PREFIXES.test(actionName) ||
    READONLY_ACTION_SUFFIXES.test(actionName)
  );
}

function hasStaticModifier(node) {
  return Boolean(
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword),
  );
}

function hasAbstractModifier(node) {
  return Boolean(
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword),
  );
}

function classExtendsRuntimeService(classNode) {
  return Boolean(
    classNode.heritageClauses?.some((clause) => {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) return false;
      return clause.types.some((type) => {
        const baseName = type.expression.getText();
        return baseName === "Service" || baseName.endsWith(".Service");
      });
    }),
  );
}

function getCallName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return expression.getText();
}

function hasTrajectoryWrapperAncestor(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isCallExpression(current) &&
      TRAJECTORY_WRAPPER_NAMES.has(getCallName(current.expression))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function lineWindowText(text, line, radius = 8) {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, line - radius - 1);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).join("\n");
}

function isRawGenerationCall(call, sourceFile, text) {
  const callName = getCallName(call.expression);
  if (RAW_GENERATION_CALLEE_NAMES.has(callName)) {
    return { match: callName };
  }
  if (callName === "fetch") {
    if (
      !(
        ts.isIdentifier(call.expression) ||
        (ts.isPropertyAccessExpression(call.expression) &&
          ts.isIdentifier(call.expression.expression) &&
          ["globalThis", "window"].includes(call.expression.expression.text))
      )
    ) {
      return null;
    }
    const line = getLine(sourceFile, call);
    const nearby = `${call.getText(sourceFile)}\n${lineWindowText(
      text,
      line,
      12,
    )}`;
    if (
      FETCH_GENERATION_PATTERN.test(nearby) &&
      FETCH_PAYLOAD_PATTERN.test(nearby)
    ) {
      return { match: "fetch" };
    }
  }
  return null;
}

function packageScope(file) {
  const parts = file.split("/");
  if (parts[0] === "plugins" && parts[1]) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === "packages" && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? file;
}

function isDelegatingWrapperObject(objectLiteral, sourceFile) {
  const arrayContext = getArrayPropertyContext(objectLiteral);
  if (
    !["actions", "providers", "evaluators", "services"].includes(arrayContext)
  ) {
    return false;
  }
  const text = objectLiteral.getText(sourceFile);
  if (arrayContext === "services") {
    const startProperty = getObjectProperty(objectLiteral, "start");
    if (!startProperty) return false;
    return /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.start\s*\(/.test(
      startProperty.getText(sourceFile),
    );
  }
  return (
    /\bimport\s*\(/.test(text) &&
    /\b(?:handler|validate|get|start)\s*:/.test(text)
  );
}

function parseSourceFiles(repoRoot, sourceFiles) {
  return sourceFiles.flatMap((filePath) => {
    const text = tryReadText(filePath);
    if (text === null) return [];
    return {
      filePath,
      relativeFile: relativePath(repoRoot, filePath),
      sourceFile: createSourceFile(filePath, text),
      text,
    };
  });
}

function collectComponentAndServiceDefinitions(parsedFiles, globalConstants) {
  const actions = [];
  const providers = [];
  const evaluators = [];
  const services = [];
  const rawGenerationCalls = [];

  for (const parsed of parsedFiles) {
    const { relativeFile, sourceFile, text } = parsed;
    const constants = collectLocalConstants(sourceFile, globalConstants);

    function addComponent(kind, node) {
      const nameProperty = getObjectProperty(node, "name");
      const name = getPropertyValue(nameProperty, constants);
      if (!name) return;
      const record = {
        file: relativeFile,
        kind,
        line: getLine(sourceFile, node),
        name,
        node,
        isDelegatingWrapper: isDelegatingWrapperObject(node, sourceFile),
        variableName: getVariableName(node),
      };
      if (kind === "action") {
        record.hasParameters = hasActionParameters(node);
        actions.push(record);
      } else if (kind === "provider") {
        providers.push(record);
      } else if (kind === "evaluator") {
        evaluators.push(record);
      }
    }

    function addService(serviceType, node, className = "") {
      if (!serviceType) return;
      services.push({
        className,
        file: relativeFile,
        isDelegatingWrapper:
          ts.isObjectLiteralExpression(node) &&
          isDelegatingWrapperObject(node, sourceFile),
        line: getLine(sourceFile, node),
        serviceType,
      });
    }

    function visit(node) {
      if (ts.isObjectLiteralExpression(node)) {
        const kind = inferComponentKind(node, relativeFile);
        if (kind) addComponent(kind, node);

        const serviceTypeProperty = getObjectProperty(node, "serviceType");
        if (
          serviceTypeProperty &&
          (getObjectProperty(node, "start") ||
            getObjectProperty(node, "stop") ||
            getArrayPropertyContext(node) === "services")
        ) {
          addService(
            getPropertyValue(serviceTypeProperty, constants, {
              allowSymbolic: true,
            }),
            node,
          );
        }
      } else if (
        ts.isClassDeclaration(node) &&
        !hasAbstractModifier(node) &&
        classExtendsRuntimeService(node)
      ) {
        for (const member of node.members) {
          if (
            ts.isPropertyDeclaration(member) &&
            hasStaticModifier(member) &&
            propertyNameText(member.name) === "serviceType"
          ) {
            addService(
              literalValue(member.initializer, constants, {
                allowSymbolic: true,
              }),
              member,
              node.name?.text ?? "",
            );
          }
        }
      } else if (ts.isCallExpression(node)) {
        const callName = getCallName(node.expression);
        if (
          callName === "defineService" &&
          node.arguments[0] &&
          ts.isObjectLiteralExpression(unwrapExpression(node.arguments[0]))
        ) {
          const definition = unwrapExpression(node.arguments[0]);
          const property = getObjectProperty(definition, "serviceType");
          addService(
            getPropertyValue(property, constants, { allowSymbolic: true }),
            node,
          );
        } else if (callName === "createService" && node.arguments[0]) {
          addService(
            literalValue(node.arguments[0], constants, {
              allowSymbolic: true,
            }),
            node,
          );
        }

        const rawCall = isRawGenerationCall(node, sourceFile, text);
        if (rawCall && !hasTrajectoryWrapperAncestor(node)) {
          const line = getLine(sourceFile, node);
          const nearby = lineWindowText(text, line, 3);
          if (!/@(?:duplicate-component-audit|trajectory)-allow/.test(nearby)) {
            rawGenerationCalls.push({
              file: relativeFile,
              line,
              match: rawCall.match,
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return {
    actions,
    evaluators,
    providers,
    rawGenerationCalls,
    services,
  };
}

function makeIssue({
  file,
  key,
  kind,
  line,
  locations = [],
  match,
  message,
  name,
  rule,
  serviceType,
  severity = "warning",
}) {
  return {
    file,
    key,
    kind,
    line,
    locations,
    match,
    message,
    name,
    rule,
    serviceType,
    severity,
  };
}

function addDuplicateIssues(issues, kind, records, valueField) {
  const groups = new Map();
  for (const record of records) {
    const value = record[valueField];
    if (!value) continue;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(record);
  }

  for (const [value, group] of groups.entries()) {
    const filteredGroup = group.filter((record) => {
      if (!record.isDelegatingWrapper) return true;
      return !group.some(
        (other) =>
          other !== record &&
          other[valueField] === value &&
          packageScope(other.file) === packageScope(record.file),
      );
    });
    if (filteredGroup.length < 2) continue;
    const locations = filteredGroup.map((record) => ({
      file: record.file,
      line: record.line,
      name: record.name,
      serviceType: record.serviceType,
    }));
    const first = filteredGroup[0];
    const rule =
      kind === "service" ? "duplicate-service-type" : DUPLICATE_RULES[kind];
    issues.push(
      makeIssue({
        file: first.file,
        key: `${rule}:${value}`,
        kind,
        line: first.line,
        locations,
        message: `${kind} value "${value}" appears ${filteredGroup.length} times`,
        name: kind === "service" ? undefined : value,
        rule,
        serviceType: kind === "service" ? value : undefined,
        severity: "error",
      }),
    );
  }
}

function collectComponentIssues(definitions, parsedFilesByRelativePath) {
  const issues = [];

  addDuplicateIssues(issues, "action", definitions.actions, "name");
  addDuplicateIssues(issues, "provider", definitions.providers, "name");
  addDuplicateIssues(issues, "evaluator", definitions.evaluators, "name");
  addDuplicateIssues(issues, "service", definitions.services, "serviceType");

  for (const provider of definitions.providers) {
    const parsed = parsedFilesByRelativePath.get(provider.file);
    if (!parsed) continue;
    if (isInstructionOnlyProvider(provider, parsed.sourceFile)) {
      issues.push(
        makeIssue({
          file: provider.file,
          key: `instruction-only-provider:${provider.name}`,
          kind: "provider",
          line: provider.line,
          message:
            "provider appears to contain static planner instructions instead of runtime state",
          name: provider.name,
          rule: "instruction-only-provider",
          severity: "warning",
        }),
      );
    }
    if (isEmptyProvider(provider, parsed.sourceFile)) {
      issues.push(
        makeIssue({
          file: provider.file,
          key: `empty-provider:${provider.name}`,
          kind: "provider",
          line: provider.line,
          message: "provider get() appears to return no text, values, or data",
          name: provider.name,
          rule: "empty-provider",
          severity: "warning",
        }),
      );
    }
  }

  for (const action of definitions.actions) {
    if (!action.hasParameters && shouldBeProviderByName(action.name)) {
      issues.push(
        makeIssue({
          file: action.file,
          key: `readonly-action-without-params:${action.name}`,
          kind: "action",
          line: action.line,
          message:
            "read-only/list/status action has no params; consider a provider or router shape",
          name: action.name,
          rule: "readonly-action-without-params",
          severity: "warning",
        }),
      );
    }
  }

  for (const rawCall of definitions.rawGenerationCalls) {
    issues.push(
      makeIssue({
        file: rawCall.file,
        key: `raw-llm-call:${rawCall.file}:${rawCall.line}:${rawCall.match}`,
        kind: "generation",
        line: rawCall.line,
        match: rawCall.match,
        message: `${rawCall.match} generation path lacks a nearby trajectory wrapper marker`,
        rule: "raw-llm-call",
        severity: "error",
      }),
    );
  }

  return issues;
}

function collectPromptIssues(repoRoot, promptFiles) {
  const issues = [];

  for (const filePath of promptFiles) {
    const relativeFile = relativePath(repoRoot, filePath);
    if (!PROMPT_LIKE_PATH_PATTERN.test(relativeFile)) continue;
    const text = tryReadText(filePath);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((lineText, index) => {
      const trimmed = lineText.trim();
      if (!trimmed) return;
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      if (NEGATED_STRUCTURED_PROMPT_PATTERN.test(trimmed)) return;
      if (NON_PROMPT_JSON_PATTERN.test(trimmed)) return;

      for (const { kind, pattern } of STRUCTURED_PROMPT_PATTERNS) {
        if (!pattern.test(trimmed)) continue;
        if (
          kind === "xml-contract" &&
          !/[`"']/.test(trimmed) &&
          SOURCE_EXTENSIONS.has(path.extname(relativeFile))
        ) {
          continue;
        }
        issues.push(
          makeIssue({
            file: relativeFile,
            key: `planner-structured-format:${relativeFile}:${index + 1}`,
            kind: "prompt",
            line: index + 1,
            match: trimmed.slice(0, 180),
            message:
              "planner-facing structured prompt appears to require text-serialized JSON/XML; prefer native function/tool calling or JSON schema",
            rule: "planner-structured-format",
            severity: "error",
          }),
        );
        break;
      }
    });
  }

  return issues;
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesFilePattern(pattern, file) {
  if (!pattern) return true;
  const normalizedPattern = toPosix(pattern);
  const normalizedFile = toPosix(file);
  if (normalizedPattern === normalizedFile) return true;
  return globToRegExp(normalizedPattern).test(normalizedFile);
}

function issueSearchText(issue) {
  return [
    issue.key,
    issue.rule,
    issue.kind,
    issue.name,
    issue.serviceType,
    issue.match,
    issue.message,
    issue.file,
    ...(issue.locations ?? []).map(
      (location) =>
        `${location.file}:${location.line}:${location.name ?? ""}:${
          location.serviceType ?? ""
        }`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

function allowlistEntryMatchesIssue(entry, issue) {
  if (entry.rule && entry.rule !== "*" && entry.rule !== issue.rule) {
    return false;
  }
  if (entry.kind && entry.kind !== issue.kind) return false;
  if (entry.severity && entry.severity !== issue.severity) return false;
  if (entry.key && entry.key !== issue.key) return false;
  if (entry.name && entry.name !== issue.name) return false;
  if (entry.serviceType && entry.serviceType !== issue.serviceType) {
    return false;
  }
  if (entry.line && Number(entry.line) !== issue.line) return false;
  if (entry.file && !matchesFilePattern(entry.file, issue.file)) {
    const relatedMatch = (issue.locations ?? []).some((location) =>
      matchesFilePattern(entry.file, location.file),
    );
    if (!relatedMatch) return false;
  }
  if (Array.isArray(entry.files) && entry.files.length > 0) {
    const issueFiles = new Set([
      issue.file,
      ...(issue.locations ?? []).map((location) => location.file),
    ]);
    for (const issueFile of issueFiles) {
      if (
        !entry.files.some((pattern) => matchesFilePattern(pattern, issueFile))
      ) {
        return false;
      }
    }
  }
  if (entry.match) {
    const text = issueSearchText(issue);
    if (!text.includes(entry.match)) return false;
  }
  return true;
}

function loadAllowlist(allowlistPath) {
  if (!allowlistPath || !fs.existsSync(allowlistPath)) {
    return { entries: [] };
  }
  const parsed = JSON.parse(readText(allowlistPath));
  if (Array.isArray(parsed)) {
    validateAllowlistEntries(parsed, allowlistPath);
    return { entries: parsed };
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Allowlist must be an object or array: ${allowlistPath}`);
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  validateAllowlistEntries(entries, allowlistPath);
  return { entries };
}

function validateAllowlistEntries(entries, allowlistPath) {
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(
        `Allowlist entry ${index + 1} must be an object: ${allowlistPath}`,
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new Error(
        `Allowlist entry ${index + 1} must include a non-empty reason: ${allowlistPath}`,
      );
    }
    if (
      !entry.key &&
      !entry.name &&
      !entry.serviceType &&
      !entry.file &&
      !(Array.isArray(entry.files) && entry.files.length > 0) &&
      !entry.match
    ) {
      throw new Error(
        `Allowlist entry ${index + 1} must include a precise selector: ${allowlistPath}`,
      );
    }
  });
}

function applyAllowlist(issues, allowlist) {
  const used = new Set();
  const unsuppressed = [];
  const suppressed = [];

  for (const issue of issues) {
    const index = allowlist.entries.findIndex((entry, entryIndex) => {
      if (used.has(entryIndex)) return false;
      return allowlistEntryMatchesIssue(entry, issue);
    });
    if (index >= 0) {
      used.add(index);
      suppressed.push(issue);
    } else {
      unsuppressed.push(issue);
    }
  }

  const unusedAllowlistEntries = allowlist.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => !used.has(index));

  return { suppressed, unsuppressed, unusedAllowlistEntries };
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function severityRank(severity) {
  if (severity === "error") return 2;
  if (severity === "warning") return 1;
  return 0;
}

function shouldFail(issues, failOn) {
  if (failOn === "none") return false;
  const threshold = failOn === "warning" ? 1 : 2;
  return issues.some((issue) => severityRank(issue.severity) >= threshold);
}

function shouldFailAudit(result, failOn) {
  return (
    shouldFail(result.unsuppressedIssues, failOn) ||
    (failOn !== "none" && result.unusedAllowlistEntries.length > 0)
  );
}

function buildResult({
  allowlist,
  definitions,
  promptFileCount,
  sourceFileCount,
  issues,
  allowlistResult,
}) {
  return {
    allowlistEntries: allowlist.entries.length,
    counts: {
      actions: definitions.actions.length,
      evaluators: definitions.evaluators.length,
      providers: definitions.providers.length,
      rawGenerationCalls: definitions.rawGenerationCalls.length,
      services: definitions.services.length,
      sourceFiles: sourceFileCount,
      promptFiles: promptFileCount,
    },
    issues,
    issueCountsByRule: countBy(issues, (issue) => issue.rule),
    unsuppressedIssues: allowlistResult.unsuppressed,
    suppressedIssues: allowlistResult.suppressed,
    unusedAllowlistEntries: allowlistResult.unusedAllowlistEntries,
  };
}

function runAudit(options) {
  const sourceFiles = walkFiles(
    options.repoRoot,
    options.roots,
    isSourceFile,
    options.includeTests,
  );
  const promptFiles = walkFiles(
    options.repoRoot,
    options.roots,
    isPromptFile,
    options.includeTests,
  );
  const parsedFiles = parseSourceFiles(options.repoRoot, sourceFiles);
  const globalConstants = collectUniqueGlobalConstants(parsedFiles);
  const definitions = collectComponentAndServiceDefinitions(
    parsedFiles,
    globalConstants,
  );
  const parsedFilesByRelativePath = new Map(
    parsedFiles.map((parsed) => [parsed.relativeFile, parsed]),
  );
  const componentIssues = collectComponentIssues(
    definitions,
    parsedFilesByRelativePath,
  );
  const promptIssues = collectPromptIssues(options.repoRoot, promptFiles);
  const issues = [...componentIssues, ...promptIssues].sort((a, b) => {
    const severity = severityRank(b.severity) - severityRank(a.severity);
    if (severity !== 0) return severity;
    return `${a.rule}:${a.file}:${a.line}`.localeCompare(
      `${b.rule}:${b.file}:${b.line}`,
    );
  });
  const allowlist = loadAllowlist(options.allowlistPath);
  const allowlistResult = applyAllowlist(issues, allowlist);

  return buildResult({
    allowlist,
    allowlistResult,
    definitions,
    issues,
    promptFileCount: promptFiles.length,
    sourceFileCount: sourceFiles.length,
  });
}

function formatLocation(issue) {
  return `${issue.file}${issue.line ? `:${issue.line}` : ""}`;
}

function formatIssue(issue) {
  const subject = issue.name ?? issue.serviceType ?? issue.match ?? issue.kind;
  const related = issue.locations?.length
    ? ` [${issue.locations
        .map((location) => `${location.file}:${location.line}`)
        .join(", ")}]`
    : "";
  return `- [${issue.severity}] ${issue.rule} ${formatLocation(
    issue,
  )} ${subject ? `${subject}: ` : ""}${issue.message}${related}`;
}

function printTextResult(result, maxIssues) {
  console.log(
    `[duplicate-component-audit] scanned ${result.counts.sourceFiles} source files and ${result.counts.promptFiles} prompt-like files`,
  );
  console.log(
    `[duplicate-component-audit] definitions: ${result.counts.actions} actions, ${result.counts.providers} providers, ${result.counts.evaluators} evaluators, ${result.counts.services} services`,
  );
  console.log(
    `[duplicate-component-audit] issues: ${result.unsuppressedIssues.length} unsuppressed, ${result.suppressedIssues.length} suppressed`,
  );

  const sortedCounts = Object.entries(
    countBy(result.unsuppressedIssues, (issue) => issue.rule),
  ).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [rule, count] of sortedCounts) {
    console.log(`[duplicate-component-audit] ${rule}: ${count}`);
  }

  if (result.unsuppressedIssues.length > 0) {
    console.log("[duplicate-component-audit] findings:");
    for (const issue of result.unsuppressedIssues.slice(0, maxIssues)) {
      console.log(formatIssue(issue));
    }
    const remaining = result.unsuppressedIssues.length - maxIssues;
    if (remaining > 0) {
      console.log(
        `[duplicate-component-audit] ... ${remaining} more findings not shown (use --json or --max-issues)`,
      );
    }
  }

  if (result.unusedAllowlistEntries.length > 0) {
    console.log(
      `[duplicate-component-audit] unused allowlist entries: ${result.unusedAllowlistEntries.length}`,
    );
  }

  if (result.unsuppressedIssues.length === 0) {
    console.log("[duplicate-component-audit] ok");
  }
}

function writeFixture(root, relativeFile, text) {
  const filePath = path.join(root, relativeFile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function assertSelfCheck(condition, message) {
  if (!condition) throw new Error(`self-check failed: ${message}`);
}

function runSelfCheck() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "duplicate-component-audit-"),
  );
  try {
    writeFixture(
      root,
      "packages/a/src/index.ts",
      `
        import type { Action, Evaluator, Provider } from "@elizaos/core";
        import { Service } from "@elizaos/core";
        const ACTION_NAME = "DUPLICATE_ACTION";
        export const duplicateActionA: Action = {
          name: ACTION_NAME,
          description: "List available things",
          validate: async () => true,
          handler: async () => undefined
        };
        export const listThings: Action = {
          name: "LIST_THINGS",
          description: "List things",
          validate: async () => true,
          handler: async () => undefined
        };
        export const duplicateProviderA: Provider = {
          name: "duplicateProvider",
          get: async () => ({ text: "Instructions: you must use this planning guidance." })
        };
        export const emptyProvider: Provider = {
          name: "emptyProvider",
          get: async () => ({ text: "" })
        };
        export const duplicateEvaluatorA: Evaluator = {
          name: "DUPLICATE_EVALUATOR",
          description: "evaluate",
          examples: [],
          validate: async () => true,
          handler: async () => undefined
        };
        export class DuplicateServiceA extends Service {
          static serviceType = "duplicate-service";
        }
        export async function rawGeneration(runtime: { useModel: Function }) {
          await runtime.useModel("TEXT_SMALL", { prompt: "hello" });
          await generateText({ model: "x", prompt: "hello" });
          await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            body: JSON.stringify({ model: "gpt", messages: [] })
          });
        }
      `,
    );
    writeFixture(
      root,
      "packages/a/src/prompts.ts",
      `
        export const plannerPrompt = \`Return ONLY JSON with {"action":"LIST_THINGS"}\`;
      `,
    );
    writeFixture(
      root,
      "plugins/b/src/index.ts",
      `
        import type { Action, Evaluator, Provider } from "@elizaos/core";
        import { Service } from "@elizaos/core";
        export const duplicateActionB: Action = {
          name: "DUPLICATE_ACTION",
          description: "Do the same thing",
          validate: async () => true,
          handler: async () => undefined,
          parameters: [{ name: "id", description: "id", schema: { type: "string" } }]
        };
        export const duplicateProviderB: Provider = {
          name: "duplicateProvider",
          get: async (runtime) => ({ text: String(runtime) })
        };
        export const duplicateEvaluatorB: Evaluator = {
          name: "DUPLICATE_EVALUATOR",
          description: "evaluate again",
          examples: [],
          validate: async () => true,
          handler: async () => undefined
        };
        export class DuplicateServiceB extends Service {
          static serviceType = "duplicate-service";
        }
      `,
    );

    const result = runAudit({
      allowlistPath: null,
      failOn: "error",
      includeTests: false,
      repoRoot: root,
      roots: ["packages", "plugins"],
    });
    const rules = new Set(result.unsuppressedIssues.map((issue) => issue.rule));
    for (const rule of [
      "duplicate-action-name",
      "duplicate-provider-name",
      "duplicate-evaluator-name",
      "duplicate-service-type",
      "instruction-only-provider",
      "empty-provider",
      "readonly-action-without-params",
      "planner-structured-format",
      "raw-llm-call",
    ]) {
      assertSelfCheck(rules.has(rule), `expected ${rule}`);
    }

    const allowlistPath = path.join(root, "allowlist.json");
    fs.writeFileSync(
      allowlistPath,
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              rule: "duplicate-action-name",
              name: "DUPLICATE_ACTION",
              reason: "self-check intentional duplicate",
            },
          ],
        },
        null,
        2,
      ),
    );
    const allowlisted = runAudit({
      allowlistPath,
      failOn: "error",
      includeTests: false,
      repoRoot: root,
      roots: ["packages", "plugins"],
    });
    assertSelfCheck(
      allowlisted.suppressedIssues.some(
        (issue) => issue.rule === "duplicate-action-name",
      ),
      "allowlist should suppress duplicate action",
    );
    fs.writeFileSync(
      allowlistPath,
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              rule: "duplicate-action-name",
              name: "DUPLICATE_ACTION",
              reason: "self-check intentional duplicate",
            },
            {
              rule: "duplicate-service-type",
              serviceType: "unused-service",
              reason: "self-check unused entry",
            },
          ],
        },
        null,
        2,
      ),
    );
    const withUnusedAllowlist = runAudit({
      allowlistPath,
      failOn: "error",
      includeTests: false,
      repoRoot: root,
      roots: ["packages", "plugins"],
    });
    assertSelfCheck(
      shouldFailAudit(withUnusedAllowlist, "error"),
      "unused allowlist entries should fail",
    );
    console.log("[duplicate-component-audit] self-check ok");
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.selfCheck) {
      runSelfCheck();
      return;
    }
    const result = runAudit(options);
    if (options.format === "json") {
      console.log(
        JSON.stringify(
          {
            ok: !shouldFailAudit(result, options.failOn),
            ...result,
          },
          null,
          2,
        ),
      );
    } else {
      printTextResult(result, options.maxIssues);
    }
    if (shouldFailAudit(result, options.failOn)) {
      process.exit(1);
    }
  } catch (error) {
    console.error(
      `[duplicate-component-audit] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}

main();
