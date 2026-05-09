#!/usr/bin/env node
/**
 * Static audit for action availability gates.
 *
 * This is intentionally heuristic: it finds action-like object literals, records
 * role/context/validate metadata, and flags validate() bodies that still look
 * intent/keyword based instead of hard state based.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const DEFAULT_ROOTS = [
  "packages/core/src",
  "packages/agent/src/actions",
  "plugins",
  "cloud/packages/lib/eliza",
];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "__tests__",
  "generated",
  "test",
  "tests",
]);

const KEYWORD_FILES = [
  "packages/shared/src/i18n/keywords/action-search.generated.keywords.json",
  "packages/shared/src/i18n/keywords/context-search.keywords.json",
  "packages/shared/src/i18n/keywords/shared.keywords.json",
  "packages/shared/src/i18n/keywords/typescript.keywords.json",
  "packages/shared/src/i18n/keywords/validate.keywords.json",
];

const CONTEXT_CONSTANTS = {
  CODING_TOOLS_CONTEXTS: ["code", "terminal", "automation"],
  POST_CONTEXTS: ["social_posting", "connectors"],
  ROOM_CONTEXTS: ["messaging", "contacts", "settings"],
  TODOS_CONTEXTS: ["tasks", "todos", "automation"],
};

const args = new Set(process.argv.slice(2));
const format = args.has("--json") ? "json" : "markdown";
const roots = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--"))
  .filter(Boolean);

const keywordKeys = loadKeywordKeys();
const files = (roots.length > 0 ? roots : DEFAULT_ROOTS).flatMap((root) =>
  walk(join(ROOT, root)),
);
const actions = files
  .flatMap(scanFile)
  .sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
const summary = buildSummary(actions);

if (format === "json") {
  console.log(JSON.stringify({ summary, actions }, null, 2));
} else {
  console.log(renderMarkdown(summary, actions));
}

function loadKeywordKeys() {
  const keys = new Set();
  for (const file of KEYWORD_FILES) {
    try {
      const parsed = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
      for (const key of Object.keys(parsed.entries ?? {})) {
        keys.add(key);
      }
    } catch {
      // Missing keyword files should not prevent source auditing.
    }
  }
  return keys;
}

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out = out.concat(walk(full));
      continue;
    }
    if (!/\.(ts|tsx|js|mjs)$/.test(entry)) continue;
    if (/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

function scanFile(file) {
  const rel = relative(ROOT, file);
  if (
    /(^|\/)routes?\//.test(rel) ||
    /(^|\/)(routes|setup-routes)\.(ts|tsx|js|mjs)$/.test(rel)
  ) {
    return [];
  }
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];

  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const action = readActionObject(source, node);
      if (action) found.push(action);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return found;
}

function readActionObject(source, node) {
  const name = getStringProperty(node, "name");
  if (!name) return null;
  if (isEvaluatorObject(source, node)) return null;

  const hasHandler = Boolean(getProperty(node, "handler"));
  const hasValidate = Boolean(getProperty(node, "validate"));
  const hasActionMetadata = [
    "contexts",
    "contextGate",
    "description",
    "descriptionCompressed",
    "examples",
    "mode",
    "parameters",
    "roleGate",
    "similes",
    "subActions",
  ].some((propertyName) => Boolean(getProperty(node, propertyName)));
  const hasActionShape = (hasHandler || hasValidate) && hasActionMetadata;
  if (!hasActionShape) return null;

  const validateNode = getPropertyInitializer(node, "validate");
  const validateText = validateNode?.getText(source) ?? "";
  const modeText = getPropertyInitializer(node, "mode")?.getText(source) ?? "";
  const contexts = getStringArrayProperty(node, "contexts");
  const similes = getStringArrayProperty(node, "similes");
  const description = getStringProperty(node, "description");
  const descriptionCompressed =
    getStringProperty(node, "descriptionCompressed") ??
    getStringProperty(node, "compressedDescription");
  const line =
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const keywordStem = actionNameToKeywordStem(name);
  const matchedKeywordKeys = [...keywordKeys]
    .filter((key) => key.startsWith(`action.${keywordStem}.`))
    .sort();

  const flags = classifyValidate(validateText, hasValidate);

  return {
    name,
    file: relative(ROOT, source.fileName),
    line,
    contexts,
    similes,
    description,
    descriptionCompressed,
    hasRoleGate: Boolean(getProperty(node, "roleGate")),
    hasContextGate: Boolean(getProperty(node, "contextGate")),
    hasSubActions: Boolean(getProperty(node, "subActions")),
    hasConnectorAccountPolicy:
      Boolean(getProperty(node, "connectorAccountPolicy")) ||
      Boolean(getProperty(node, "accountPolicy")),
    isInternalMode: /ActionMode\.ALWAYS_(?:BEFORE|DURING|AFTER)/.test(modeText),
    validate: flags,
    keywordKeys: matchedKeywordKeys,
    needsHardStateReview: needsHardStateReview({
      name,
      contexts,
      flags,
      hasConnectorAccountPolicy:
        Boolean(getProperty(node, "connectorAccountPolicy")) ||
        Boolean(getProperty(node, "accountPolicy")),
    }),
  };
}

function isEvaluatorObject(source, node) {
  const parent = node.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.type?.getText(source).includes("Evaluator")
  ) {
    return true;
  }
  if (
    ts.isPropertyAssignment(parent) &&
    parent.name &&
    /evaluator/i.test(parent.name.getText(source))
  ) {
    return true;
  }
  return false;
}

function classifyValidate(text, hasValidate) {
  if (!hasValidate) {
    return {
      kind: "missing",
      intentKeywordSignals: [],
      stateSignals: [],
      notes: ["missing validate()"],
    };
  }
  const compact = text.replace(/\s+/g, " ").trim();
  const intentKeywordSignals = matchAll(compact, [
    "validateActionKeywords",
    "getValidationKeywordTerms",
    "findKeywordTermMatch",
    "collectKeywordTermMatches",
    "hasSelectedContextOrSignal",
    "hasMediaActionSignal",
    "looksLike[A-Za-z0-9_]*Intent",
    "KEYWORD_HEURISTIC",
    "recentMessages",
    "message\\.content\\.text",
    "content\\.text",
    "messageText\\(",
  ]);
  const stateSignals = matchAll(compact, [
    "getService",
    "getSetting",
    "process\\.env",
    "createEvmActionValidator",
    "extractId",
    "extractTitle",
    "connectorAccountPolicy",
    "accountPolicy",
    "getParticipantUserState",
    "getPluginManager",
    "getRoom",
    "getWorld",
    "hasActionContextOrKeyword",
    "hasSelectedContext",
    "hasLifeOpsAccess",
    "hasLinearAccess",
    "checkSenderRole",
    "hasRoleAccess",
    "triggersFeatureEnabled",
    "selectedContextMatches",
    "serviceFromRuntime",
    "validateLinearActionIntent",
    "validateRouter",
    "runtime\\.agentId",
    "message\\.entityId",
    "state\\.data",
    "pageScope",
    "feature",
    "fetch",
    "configured",
    "connected",
    "available",
    "enabled",
    "muted",
    "FOLLOWED",
    "MUTED",
  ]);
  const alwaysTrue =
    /^(?:async\s*)?\(?[^)]*\)?\s*=>\s*true$/.test(compact) ||
    /return true;?\s*}?$/.test(compact);

  let kind = "unclear";
  const notes = [];
  if (intentKeywordSignals.length > 0) {
    kind = "keyword_or_intent";
    notes.push("move keyword/intent matching to action retrieval");
  } else if (stateSignals.length > 0) {
    kind = "state_based";
    notes.push("has hard state/service/account signals");
  } else if (alwaysTrue) {
    kind = "always_available";
    notes.push("always true after context/role gates");
  }

  return {
    kind,
    intentKeywordSignals,
    stateSignals,
    notes,
  };
}

function needsHardStateReview({
  name,
  contexts,
  flags,
  hasConnectorAccountPolicy,
}) {
  const sensitiveContext = contexts.some((context) =>
    [
      "admin",
      "agent_internal",
      "automation",
      "browser",
      "code",
      "connectors",
      "email",
      "files",
      "finance",
      "health",
      "messaging",
      "payments",
      "phone",
      "screen_time",
      "secrets",
      "settings",
      "social",
      "social_posting",
      "subscriptions",
      "terminal",
      "wallet",
    ].includes(context),
  );
  const statefulName =
    /(MUTE|UNMUTE|FOLLOW|UNFOLLOW|SEND|DELETE|UPDATE|SET|CREATE|CONNECT|DISCONNECT|BASH|TERMINAL|WALLET|PAY|SECRET|ROLE|PLUGIN|WORKFLOW|TRIGGER)/.test(
      name,
    );
  if (flags.kind === "keyword_or_intent" || flags.kind === "missing")
    return true;
  if (hasConnectorAccountPolicy) return false;
  if (flags.kind === "always_available") return false;
  return sensitiveContext && statefulName && flags.kind !== "state_based";
}

function buildSummary(items) {
  return {
    totalActions: items.length,
    internalModeActions: items.filter((item) => item.isInternalMode).length,
    missingRoleGate: items.filter(
      (item) => !item.isInternalMode && !item.hasRoleGate,
    ).length,
    missingValidate: items.filter((item) => item.validate.kind === "missing")
      .length,
    keywordOrIntentValidate: items.filter(
      (item) => item.validate.kind === "keyword_or_intent",
    ).length,
    unclearValidate: items.filter((item) => item.validate.kind === "unclear")
      .length,
    stateBasedValidate: items.filter(
      (item) => item.validate.kind === "state_based",
    ).length,
    alwaysAvailableValidate: items.filter(
      (item) => item.validate.kind === "always_available",
    ).length,
    missingExternalActionKeywords: items.filter(
      (item) => item.keywordKeys.length === 0,
    ).length,
    needsHardStateReview: items.filter((item) => item.needsHardStateReview)
      .length,
  };
}

function renderMarkdown(summary, items) {
  const lines = [
    "# Action Availability Audit",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    `- Total action-like objects: ${summary.totalActions}`,
    `- Internal mode actions/evaluators: ${summary.internalModeActions}`,
    `- Missing explicit roleGate: ${summary.missingRoleGate}`,
    `- Missing validate(): ${summary.missingValidate}`,
    `- Keyword/intent validate(): ${summary.keywordOrIntentValidate}`,
    `- Unclear validate(): ${summary.unclearValidate}`,
    `- State-based validate(): ${summary.stateBasedValidate}`,
    `- Always-available validate(): ${summary.alwaysAvailableValidate}`,
    `- Missing external action keyword keys: ${summary.missingExternalActionKeywords}`,
    `- Needs hard-state review: ${summary.needsHardStateReview}`,
    "",
    "## Actions",
    "",
    "| Action | File | Contexts | Role | Validate | Keywords | Review |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const item of items) {
    lines.push(
      `${[
        escapeCell(item.name),
        escapeCell(`${item.file}:${item.line}`),
        escapeCell(item.contexts.join(", ") || "-"),
        item.hasRoleGate ? "yes" : item.isInternalMode ? "internal" : "missing",
        escapeCell(item.validate.kind),
        escapeCell(item.keywordKeys.join(", ") || "missing"),
        item.needsHardStateReview ? "yes" : "",
      ]
        .join(" | ")
        .replace(/^/, "| ")} |`,
    );
  }

  return lines.join("\n");
}

function getProperty(node, name) {
  return node.properties.find(
    (property) => propertyName(property.name) === name,
  );
}

function getPropertyInitializer(node, name) {
  const property = getProperty(node, name);
  if (!property) return undefined;
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  if (ts.isMethodDeclaration(property)) return property.body;
  return undefined;
}

function getStringProperty(node, name) {
  const initializer = getPropertyInitializer(node, name);
  if (!initializer) return undefined;
  if (ts.isStringLiteralLike(initializer)) return initializer.text;
  return undefined;
}

function getStringArrayProperty(node, name) {
  const initializer = getPropertyInitializer(node, name);
  if (!initializer) return [];
  if (ts.isIdentifier(initializer)) {
    return CONTEXT_CONSTANTS[initializer.text] ?? [];
  }
  if (!ts.isArrayLiteralExpression(initializer)) return [];
  return initializer.elements.flatMap((element) => {
    if (ts.isStringLiteralLike(element)) return [element.text];
    if (
      ts.isSpreadElement(element) &&
      ts.isIdentifier(element.expression) &&
      CONTEXT_CONSTANTS[element.expression.text]
    ) {
      return CONTEXT_CONSTANTS[element.expression.text];
    }
    return [];
  });
}

function propertyName(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function matchAll(text, patterns) {
  return patterns.filter((pattern) => new RegExp(pattern).test(text));
}

function actionNameToKeywordStem(actionName) {
  const words = String(actionName ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/g)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  if (words.length === 0) return "";
  return [words[0], ...words.slice(1).map(capitalizeAscii)].join("");
}

function capitalizeAscii(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}
