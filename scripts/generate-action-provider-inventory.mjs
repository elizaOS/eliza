#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const repoRoot = process.cwd();
const outFile = path.join(repoRoot, "ACTION_PROVIDER_INVENTORY.md");

const SOURCE_ROOTS = ["packages", "plugins", "cloud"];
const EXCLUDE_RE =
  /(^|\/)(dist|build|coverage|node_modules|\.turbo|\.next|generated)(\/|$)|(\.d\.ts$)|(\.(test|spec)\.tsx?$)|(^|\/)(__tests__|test|tests|templates)(\/|$)/;
const EXCLUDED_PATH_PREFIXES = [
  "packages/examples/",
  "packages/app-core/src/components/custom-actions/",
  "packages/app-core/src/benchmark/",
  "packages/agent/src/api/",
];

const ACTION_RESULT_FIELDS = [
  "success",
  "text",
  "values",
  "data",
  "error",
  "continueChain",
  "cleanup",
];
const PROVIDER_RESULT_FIELDS = ["text", "values", "data"];

const EXTERNAL_PATTERNS = [
  ["fetch/http", /\bfetch\s*\(|\baxios\b|\bgot\s*\(|\bky\s*\(|\brequest\s*\(/],
  [
    "sdk/client",
    /\b(client|api|sdk)\.[a-zA-Z_$][\w$]*\s*\(|\.chat\.|\.messages\.|\.users\.|\.channels\.|\.rooms\.|\.calendar\b|\.gmail\b|\.slack\b|\.discord\b|\.twitter\b|\.x\b/,
  ],
  [
    "runtime-service",
    /runtime\.getService|runtime\.getServiceByType|runtime\.services|ServiceType\./,
  ],
  ["llm", /runtime\.useModel|useModel\s*\(|ModelType\./],
  [
    "database/memory",
    /\b(database|db|repository|repositories|prisma|drizzle|sql|createMemory|getMemories|updateMemory|deleteMemory|getCachedEmbeddings)\b/,
  ],
  [
    "cache",
    /\b(getCache|setCache|deleteCache|CacheManager|cache\.|cached|memoized|ttl|expiresAt)\b/,
  ],
  [
    "filesystem",
    /\bfs\.|readFile|writeFile|mkdir|rm\(|unlink|Bun\.file|Bun\.write/,
  ],
  ["process/shell", /child_process|execFile|exec\s*\(|spawn\s*\(|Bun\.\$/],
  [
    "browser/device",
    /Browser|browser\.|page\.|chromium|playwright|computerUse|desktop|screen|clipboard/,
  ],
];

const LIMIT_PATTERNS = [
  ["slice", /\.slice\s*\(/],
  [
    "limit",
    /\blimit\b|MAX_|max[A-Z_]|pageSize|page_size|perPage|first:\s*\d+|take:\s*\d+/,
  ],
  ["truncate", /truncate|substring\s*\(|\.substr\s*\(|\.slice\s*\(\s*0\s*,/],
  ["pagination", /cursor|offset|pageToken|nextPage|hasMore|pagination/],
  ["timeout/retry", /timeout|AbortController|retry|rateLimit|backoff/],
  [
    "bounded-helper",
    /\b(successActionResult|failureToActionResult|formatActionResponse|formatActionResult|emitResult|emit\()\b/,
  ],
];
const ACTION_CAP_EXTERNAL_LABELS = new Set([
	"fetch/http",
	"process/shell",
]);

function gitFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", ...SOURCE_ROOTS],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return output
    .split("\n")
    .filter(Boolean)
    .filter((file) => fs.existsSync(path.join(repoRoot, file)))
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !EXCLUDE_RE.test(file))
    .filter(
      (file) =>
        !EXCLUDED_PATH_PREFIXES.some((prefix) => file.startsWith(prefix)),
    );
}

function sourceKind(file) {
  if (file.startsWith("packages/core/")) return "core";
  if (file.startsWith("packages/agent/")) return "agent";
  if (file.startsWith("packages/app-core/")) return "app-core";
  if (file.startsWith("packages/prompts/")) return "prompts";
  if (file.startsWith("packages/training/")) return "training";
  if (file.startsWith("packages/examples/")) return "example";
  const native = file.match(/^packages\/native-plugins\/([^/]+)\//);
  if (native) return `native-plugin:${native[1]}`;
  const plugin = file.match(/^plugins\/([^/]+)\//);
  if (plugin) return `plugin:${plugin[1]}`;
  const cloudPlugin = file.match(
    /^cloud\/packages\/lib\/eliza\/(plugin-[^/]+)\//,
  );
  if (cloudPlugin) return `cloud:${cloudPlugin[1]}`;
  const cloudEliza = file.match(/^cloud\/packages\/lib\/eliza\/([^/]+)\//);
  if (cloudEliza) return `cloud:${cloudEliza[1]}`;
  if (file.startsWith("cloud/")) return "cloud";
  if (file.startsWith("packages/")) return `package:${file.split("/")[1]}`;
  return "repo";
}

function propName(prop) {
  const name = prop.name;
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  )
    return name.text;
  return name.getText();
}

function getProp(obj, names) {
  const wanted = Array.isArray(names) ? new Set(names) : new Set([names]);
  for (const prop of obj.properties) {
    if (
      (ts.isPropertyAssignment(prop) ||
        ts.isMethodDeclaration(prop) ||
        ts.isShorthandPropertyAssignment(prop)) &&
      wanted.has(propName(prop))
    ) {
      return prop;
    }
  }
  return undefined;
}

function getPropExpression(prop) {
  if (!prop) return undefined;
  if (ts.isPropertyAssignment(prop)) return prop.initializer;
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name;
  return prop;
}

function literalText(expr) {
  if (!expr) return undefined;
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (ts.isNumericLiteral(expr)) return expr.text;
  return undefined;
}

function collectStaticBindings(sf) {
  const stringBindings = new Map();
  const specBindings = new Map();

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (initializer) {
        const literal = literalText(initializer);
        if (literal !== undefined) {
          stringBindings.set(node.name.text, literal);
        } else if (
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          (initializer.expression.text === "requireActionSpec" ||
            initializer.expression.text === "requireProviderSpec")
        ) {
          const [firstArg] = initializer.arguments;
          const specName = literalText(firstArg);
          if (specName) specBindings.set(node.name.text, specName);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return { stringBindings, specBindings };
}

function resolvedLiteralText(expr, bindings) {
  const direct = literalText(expr);
  if (direct !== undefined) return direct;
  if (bindings && ts.isIdentifier(expr)) {
    return bindings.stringBindings.get(expr.text);
  }
  if (
    bindings &&
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "name" &&
    ts.isIdentifier(expr.expression)
  ) {
    return bindings.specBindings.get(expr.expression.text);
  }
  return undefined;
}

function exprText(expr, sf, max = 220) {
  if (!expr) return "";
  const text = expr.getText(sf).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function stringArray(expr, sf) {
  if (!expr) return [];
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements
      .map((element) => {
        if (ts.isStringLiteralLike(element)) return element.text;
        if (ts.isObjectLiteralExpression(element)) {
          const name = literalText(getPropExpression(getProp(element, "name")));
          return name ? `{${name}}` : exprText(element, sf, 80);
        }
        return exprText(element, sf, 80);
      })
      .filter(Boolean);
  }
  return [exprText(expr, sf, 100)].filter(Boolean);
}

function lineFor(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function declarationName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name))
      return current.name.text;
    if (ts.isPropertyAssignment(current)) return propName(current);
    if (ts.isExportAssignment(current)) return "default";
    current = current.parent;
  }
  return "";
}

function declarationType(node) {
  let current = node.parent;
  while (current) {
    if (ts.isVariableDeclaration(current) && current.type)
      return current.type.getText();
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression?.(current))
      return current.type.getText();
    current = current.parent;
  }
  return "";
}

function propSource(obj, name, sf, max = 260) {
  const prop = getProp(obj, name);
  if (!prop) return "";
  return exprText(getPropExpression(prop), sf, max);
}

function functionText(prop, sf) {
  if (!prop) return "";
  if (ts.isMethodDeclaration(prop)) return prop.getText(sf);
  const expr = getPropExpression(prop);
  if (!expr) return "";
  return expr.getText(sf);
}

function looksAlwaysTrue(text) {
  const compact = text.replace(/\s+/g, " ");
  if (/=>\s*(true|Promise\.resolve\(true\))\b/.test(compact)) {
    return true;
  }
  if (/async\s*\([^)]*\)\s*=>\s*true\b/.test(compact)) {
    return true;
  }
  const bodyMatch = compact.match(/(?:=>|validate\s*\([^)]*\))\s*\{(.*)\}\s*$/);
  const body = (bodyMatch?.[1] ?? compact)
    .replace(/\/\*.*?\*\//g, "")
    .replace(/\/\/.*?(?=\n|$)/g, "")
    .trim();
  return /^(?:return\s+)?(?:true|Promise\.resolve\(true\))\s*;?$/.test(body);
}

function summarizeValidation(obj, sf) {
  const validate = getProp(obj, "validate");
  if (!validate)
    return { kind: "missing", detail: "No validate property found." };
  const text = functionText(validate, sf);
  if (looksAlwaysTrue(text))
    return {
      kind: "always_true",
      detail: "validate returns true without gating.",
    };
  const detailParts = [];
  if (/hasOwnerAccess|owner/i.test(text)) detailParts.push("owner gate");
  if (/hasAdminAccess|admin/i.test(text)) detailParts.push("admin gate");
  if (/roleGate|contextGate/.test(text)) detailParts.push("context/role gate");
  if (/runtime\.getSetting|getSetting|env|process\.env/.test(text))
    detailParts.push("setting/env gate");
  if (/runtime\.getService|getService/.test(text))
    detailParts.push("service gate");
  if (/message|content|text/.test(text))
    detailParts.push("message/content gate");
  if (/try\s*{/.test(text)) detailParts.push("try/catch");
  return {
    kind: detailParts.length ? "conditional" : "custom",
    detail: detailParts.length
      ? detailParts.join(", ")
      : exprText(getPropExpression(validate), sf, 180),
  };
}

function summarizeCache(obj, body, _sf) {
  const cacheStable = literalText(
    getPropExpression(getProp(obj, "cacheStable")),
  );
  const cacheScope = literalText(getPropExpression(getProp(obj, "cacheScope")));
  const explicit = [];
  if (cacheStable) explicit.push(`cacheStable=${cacheStable}`);
  if (cacheScope) explicit.push(`cacheScope=${cacheScope}`);
  const custom =
    /\b(getCache|setCache|deleteCache|CacheManager|memo|ttl|expiresAt|cached)\b/i.test(
      body,
    );
  if (explicit.length && custom)
    return `${explicit.join(", ")}; custom cache logic detected`;
  if (explicit.length) return explicit.join(", ");
  if (custom) return "custom cache logic detected";
  return "always_refetch_or_runtime_cache_unknown";
}

function matchLabels(text, patterns) {
  return patterns.filter(([, re]) => re.test(text)).map(([label]) => label);
}

function returnSnippets(text) {
  const snippets = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (/\breturn\b|\bthrow\b|callback\s*\??\s*\(/.test(lines[i])) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 4);
      const snippet = lines.slice(start, end).join("\n").trim();
      if (snippet) snippets.push(snippet.replace(/\s+\n/g, "\n").slice(0, 700));
    }
  }
  return [...new Set(snippets)].slice(0, 12);
}

function outputSummary(text, fields) {
  const pieces = [];
  for (const field of fields) {
    if (new RegExp(`\\b${field}\\s*:`).test(text)) pieces.push(field);
  }
  if (/successActionResult\s*\(/.test(text)) pieces.push("success");
  if (/failureToActionResult\s*\(/.test(text))
    pieces.push("success", "text", "error");
  if (/callback\s*\??\s*\(/.test(text)) pieces.push("callback");
  if (/return\s+(true|false)\b/.test(text)) pieces.push("boolean-return");
  if (/throw\s+/.test(text)) pieces.push("throws");
  if (/return\s+await\s+|return\s+[a-zA-Z_$][\w$]*\(/.test(text))
    pieces.push("delegated-return");
  return pieces.length ? [...new Set(pieces)].join(", ") : "unknown/delegated";
}

function successFailure(text) {
  const successTrue = /success\s*:\s*true/.test(text);
  const successFalse = /success\s*:\s*false/.test(text);
  const successHelper = /successActionResult\s*\(/.test(text);
  const failureHelper = /failureToActionResult\s*\(/.test(text);
  const throws = /throw\s+/.test(text);
  const catches = /catch\s*\(/.test(text) || /catch\s*{/.test(text);
  const callback = /callback\s*\??\s*\(/.test(text);
  const parts = [];
  if (successTrue || successHelper) parts.push("success branch");
  if (successFalse || failureHelper) parts.push("failure branch");
  if (throws) parts.push("throws");
  if (catches) parts.push("catch");
  if (callback) parts.push("callback output");
  return parts.length ? parts.join(", ") : "not statically obvious";
}

function cleanupForAction(action) {
  const issues = [];
  const capRelevantExternal = action.externalApis.some((label) =>
    ACTION_CAP_EXTERNAL_LABELS.has(label),
  );
  if (!action.contexts.length && !action.contextGate)
    issues.push("add context metadata");
  if (action.validationKind === "missing") issues.push("add validate()");
  if (action.validationKind === "always_true")
    issues.push("review permissive validation/role gate");
  if (!action.parametersDeclared)
    issues.push("add native parameters if action accepts inputs");
  if (
    !/success/.test(action.stackOutput) &&
    !/delegated/.test(action.stackOutput)
  )
    issues.push("return structured ActionResult");
  if (
    action.externalApis.length &&
    !/failure branch|catch/.test(action.errorHandling)
  )
    issues.push("wrap external calls in failure result");
  if (capRelevantExternal && !action.limits.length)
    issues.push("cap external results/timeouts");
  if (action.subActions.length && !action.subPlanner)
    issues.push("confirm sub-planner behavior");
  if (!issues.length) return "looks aligned; verify runtime trajectory event";
  return issues.join("; ");
}

function cleanupForProvider(provider) {
  const issues = [];
  if (!provider.contexts.length && !provider.contextGate)
    issues.push("add context metadata");
  if (provider.cache === "always_refetch_or_runtime_cache_unknown")
    issues.push("declare cacheStable/cacheScope or cache policy");
  if (provider.externalApis.length && !provider.limits.length)
    issues.push("cap external/provider data");
  if (
    provider.externalApis.length &&
    !/catch|failure|error/i.test(provider.errorHandling)
  )
    issues.push("add explicit error fallback");
  if (!/text|values|data/.test(provider.stackOutput))
    issues.push("return ProviderResult fields explicitly");
  if (!issues.length) return "looks aligned; verify segment hashing";
  return issues.join("; ");
}

function makeRecord(file, sf, obj, kind, bindings) {
  const bodyProp =
    kind === "action" ? getProp(obj, "handler") : getProp(obj, "get");
  const body = functionText(bodyProp, sf);
  const nameExpr = getPropExpression(getProp(obj, "name"));
  const validation = summarizeValidation(obj, sf);
  const contexts = stringArray(getPropExpression(getProp(obj, "contexts")), sf);
  const contextGate = propSource(obj, "contextGate", sf, 180);
  const roleGate = propSource(obj, "roleGate", sf, 140);
  const subActions = stringArray(
    getPropExpression(getProp(obj, "subActions")),
    sf,
  );
  const parametersProp = getProp(obj, "parameters");
  const parameters = stringArray(getPropExpression(parametersProp), sf);
  const limitAnalysisText = `${sf.text.slice(0, obj.end)}\n${body}`;
  const limits = matchLabels(limitAnalysisText, LIMIT_PATTERNS);
  const externalApis = matchLabels(body, EXTERNAL_PATTERNS);
  const description = propSource(
    obj,
    ["descriptionCompressed", "compressedDescription", "description"],
    sf,
    220,
  );
  const common = {
    kind,
    name:
      resolvedLiteralText(nameExpr, bindings) ??
      exprText(nameExpr, sf, 100) ??
      declarationName(obj) ??
      "(dynamic name)",
    declarationName: declarationName(obj),
    declarationType: declarationType(obj),
    source: sourceKind(file),
    file,
    line: lineFor(sf, obj),
    description,
    contexts,
    contextGate,
    roleGate,
    subActions,
    subPlanner: Boolean(getProp(obj, "subPlanner")),
    parametersDeclared: Boolean(parametersProp),
    externalApis,
    limits,
    stackOutput: outputSummary(
      body,
      kind === "action" ? ACTION_RESULT_FIELDS : PROVIDER_RESULT_FIELDS,
    ),
    errorHandling: successFailure(body),
    outputCases: returnSnippets(body),
  };
  if (kind === "action") {
    const action = {
      ...common,
      parameters,
      validationKind: validation.kind,
      validationDetail: validation.detail,
    };
    action.cleanup = cleanupForAction(action);
    return action;
  }
  const provider = {
    ...common,
    cache: summarizeCache(obj, body, sf),
  };
  provider.cleanup = cleanupForProvider(provider);
  return provider;
}

function shouldSkipAction(file, obj) {
  const name = declarationName(obj).toLowerCase();
  const type = declarationType(obj).toLowerCase();
  if (file.includes("/evaluators/") || file.includes("/evaluator")) return true;
  if (name.includes("evaluator") || type.includes("evaluator")) return true;
  if (getProp(obj, "alwaysRun")) return true;
  return false;
}

function scanFile(file) {
  const abs = path.join(repoRoot, file);
  const source = fs.readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = collectStaticBindings(sf);
  const records = [];
  const seen = new Set();

  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const key = `${file}:${node.pos}`;
      if (!seen.has(key)) {
        seen.add(key);
        const name = getProp(node, "name");
        const handler = getProp(node, "handler");
        const validate = getProp(node, "validate");
        const get = getProp(node, "get");
        const inActionPath =
          /(^|\/)(actions?|action)\//.test(file) ||
          /(^|\/)action\.tsx?$/.test(file);
        const inProviderPath =
          /(^|\/)(providers?|provider)\//.test(file) ||
          /(^|\/)provider\.tsx?$/.test(file);
        const type = declarationType(node);
        const maybeProvider =
          name &&
          get &&
          (inProviderPath ||
            /Provider\b/.test(type) ||
            getProp(node, "cacheStable") ||
            getProp(node, "contexts"));
        const maybeAction =
          name &&
          handler &&
          !get &&
          !shouldSkipAction(file, node) &&
          (validate ||
            inActionPath ||
            /Action\b/.test(type) ||
            getProp(node, "parameters") ||
            getProp(node, "subActions"));
        if (maybeProvider)
          records.push(makeRecord(file, sf, node, "provider", bindings));
        else if (maybeAction)
          records.push(makeRecord(file, sf, node, "action", bindings));
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return records;
}

function mdEscape(value) {
  const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  return text.replace(/\|/g, "\\|").replace(/\n/g, "<br>").trim() || "-";
}

function relLink(record) {
  const abs = path.join(repoRoot, record.file);
  return `[${record.file}:${record.line}](${abs}:${record.line})`;
}

function row(cols) {
  return `| ${cols.map(mdEscape).join(" | ")} |`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function countBy(items, fn) {
  const map = new Map();
  for (const item of items) {
    const key = fn(item);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort(
    (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])),
  );
}

function buildActionTrees(actions) {
  const byName = new Map();
  for (const action of actions) {
    if (!byName.has(action.name)) byName.set(action.name, action);
    if (action.declarationName && !byName.has(action.declarationName)) {
      byName.set(action.declarationName, action);
    }
  }
  const children = new Set(
    actions.flatMap((action) =>
      action.subActions.map((child) => child.replace(/^\{|\}$/g, "")),
    ),
  );
  const roots = actions.filter(
    (action) => action.subActions.length && !children.has(action.name),
  );
  const lines = [];

  function emit(action, depth, trail) {
    const prefix = `${"  ".repeat(depth)}-`;
    lines.push(
      `${prefix} ${action.name} (${action.source}; ${action.contexts.join(", ") || action.contextGate || "context missing"}) - ${action.cleanup}`,
    );
    if (trail.has(action.name)) {
      lines.push(`${"  ".repeat(depth + 1)}- cycle detected`);
      return;
    }
    const nextTrail = new Set(trail);
    nextTrail.add(action.name);
    for (const childNameRaw of action.subActions) {
      const childName = childNameRaw.replace(/^\{|\}$/g, "");
      const child = byName.get(childName);
      if (child) emit(child, depth + 1, nextTrail);
      else
        lines.push(
          `${"  ".repeat(depth + 1)}- ${childName} (missing static definition)`,
        );
    }
  }

  for (const root of roots) emit(root, 0, new Set());
  return lines.length
    ? lines.join("\n")
    : "No static sub-action trees detected.";
}

function detailsSection(title, records) {
  const lines = [`## ${title}`, ""];
  for (const record of records) {
    lines.push(
      `<details><summary>${record.name} - ${record.source} - ${record.file}:${record.line}</summary>`,
      "",
    );
    lines.push(`- Description: ${record.description || "-"}`);
    lines.push(`- Contexts: ${record.contexts.join(", ") || "-"}`);
    if (record.contextGate)
      lines.push(`- Context gate: \`${record.contextGate}\``);
    if (record.roleGate) lines.push(`- Role gate: \`${record.roleGate}\``);
    if (record.kind === "action") {
      lines.push(
        `- Validation: ${record.validationKind} - ${record.validationDetail}`,
      );
      lines.push(
        `- Parameters: ${record.parameters.length ? record.parameters.join(", ") : "-"}`,
      );
      lines.push(
        `- Sub-actions: ${record.subActions.length ? record.subActions.join(", ") : "-"}`,
      );
    } else {
      lines.push(`- Cache: ${record.cache}`);
      lines.push(
        `- Companion/sub-actions: ${record.subActions.length ? record.subActions.join(", ") : "-"}`,
      );
    }
    lines.push(`- External APIs: ${record.externalApis.join(", ") || "-"}`);
    lines.push(`- Stack output: ${record.stackOutput}`);
    lines.push(`- Limits/caps: ${record.limits.join(", ") || "-"}`);
    lines.push(`- Error/success handling: ${record.errorHandling}`);
    lines.push(`- Cleanup assessment: ${record.cleanup}`);
    lines.push(`- Source: ${relLink(record)}`);
    if (record.outputCases.length) {
      lines.push("", "Output / return cases observed:", "");
      for (const snippet of record.outputCases) {
        lines.push("```ts", snippet, "```", "");
      }
    }
    lines.push("</details>", "");
  }
  return lines.join("\n");
}

function buildMarkdown(records, filesScanned) {
  const actions = records
    .filter((record) => record.kind === "action")
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.name.localeCompare(b.name) ||
        a.file.localeCompare(b.file),
    );
  const providers = records
    .filter((record) => record.kind === "provider")
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.name.localeCompare(b.name) ||
        a.file.localeCompare(b.file),
    );
  const generatedAt = new Date().toISOString();

  const actionRisk = {
    missingContext: actions.filter((a) => !a.contexts.length && !a.contextGate)
      .length,
    alwaysTrue: actions.filter((a) => a.validationKind === "always_true")
      .length,
    missingParams: actions.filter((a) => !a.parametersDeclared).length,
    externalNoFailure: actions.filter(
      (a) =>
        a.externalApis.length && !/failure branch|catch/.test(a.errorHandling),
    ).length,
    noStructuredResult: actions.filter(
      (a) => !/success|delegated/.test(a.stackOutput),
    ).length,
    subActionParents: actions.filter((a) => a.subActions.length).length,
  };
  const providerRisk = {
    missingContext: providers.filter(
      (p) => !p.contexts.length && !p.contextGate,
    ).length,
    noCachePolicy: providers.filter(
      (p) => p.cache === "always_refetch_or_runtime_cache_unknown",
    ).length,
    externalNoCaps: providers.filter(
      (p) => p.externalApis.length && !p.limits.length,
    ).length,
    externalNoFallback: providers.filter(
      (p) =>
        p.externalApis.length && !/catch|failure|error/i.test(p.errorHandling),
    ).length,
  };
  const actionCapReview = actions.filter((a) =>
    a.cleanup.includes("cap external results/timeouts"),
  );
  const hardActionBlockers =
    actionRisk.missingContext +
    actionRisk.missingParams +
    actionRisk.externalNoFailure +
    actionRisk.noStructuredResult;
  const hardProviderBlockers =
    providerRisk.missingContext +
    providerRisk.noCachePolicy +
    providerRisk.externalNoCaps +
    providerRisk.externalNoFallback;

  const lines = [];
  lines.push("# Action and Provider Inventory", "");
  lines.push(`Generated: ${generatedAt}`);
  lines.push("");
  lines.push(
    "Scope: production TypeScript/TSX source under `packages/`, `plugins/`, and `cloud/`. Excludes tests, templates, generated output, build/dist folders, declarations, and dependency folders. This is static analysis, so runtime-generated MCP tools and dynamic registrations are called out only when their factory objects are visible in source.",
  );
  lines.push("");
  lines.push("## Summary", "");
  lines.push(`- Files scanned: ${filesScanned}`);
  lines.push(`- Actions detected: ${actions.length}`);
  lines.push(`- Providers detected: ${providers.length}`);
  lines.push(
    `- Sources with actions/providers: ${unique(records.map((record) => record.source)).join(", ")}`,
  );
  lines.push("");
  lines.push("### Action cleanup counters", "");
  for (const [key, value] of Object.entries(actionRisk))
    lines.push(`- ${key}: ${value}`);
  lines.push(`- advisoryCapReview: ${actionCapReview.length}`);
  lines.push("");
  lines.push("### Provider cleanup counters", "");
  for (const [key, value] of Object.entries(providerRisk))
    lines.push(`- ${key}: ${value}`);
  lines.push("");
  lines.push(
    `Hard blocker status: ${hardActionBlockers + hardProviderBlockers === 0 ? "clear" : "blocked"} (${hardActionBlockers} action, ${hardProviderBlockers} provider).`,
  );
  lines.push("");
  lines.push("### Counts by source", "");
  lines.push(row(["Source", "Actions", "Providers"]));
  lines.push(row(["---", "---:", "---:"]));
  const sources = unique(records.map((record) => record.source));
  for (const source of sources) {
    lines.push(
      row([
        source,
        actions.filter((a) => a.source === source).length,
        providers.filter((p) => p.source === source).length,
      ]),
    );
  }
  lines.push("");
  lines.push("### Cleanup by source", "");
  lines.push(
    row([
      "Source",
      "Actions",
      "Action missing ctx",
      "Always true validate",
      "Missing params",
      "Unstructured output",
      "External no failure",
      "Providers",
      "Provider missing ctx",
      "No cache policy",
      "External no caps",
      "External no fallback",
    ]),
  );
  lines.push(
    row([
      "---",
      "---:",
      "---:",
      "---:",
      "---:",
      "---:",
      "---:",
      "---:",
      "---:",
      "---:",
      "---:",
      "---:",
    ]),
  );
  for (const source of sources) {
    const sourceActions = actions.filter((a) => a.source === source);
    const sourceProviders = providers.filter((p) => p.source === source);
    lines.push(
      row([
        source,
        sourceActions.length,
        sourceActions.filter((a) => !a.contexts.length && !a.contextGate)
          .length,
        sourceActions.filter((a) => a.validationKind === "always_true").length,
        sourceActions.filter((a) => !a.parametersDeclared).length,
        sourceActions.filter((a) => !/success|delegated/.test(a.stackOutput))
          .length,
        sourceActions.filter(
          (a) =>
            a.externalApis.length &&
            !/failure branch|catch/.test(a.errorHandling),
        ).length,
        sourceProviders.length,
        sourceProviders.filter((p) => !p.contexts.length && !p.contextGate)
          .length,
        sourceProviders.filter(
          (p) => p.cache === "always_refetch_or_runtime_cache_unknown",
        ).length,
        sourceProviders.filter((p) => p.externalApis.length && !p.limits.length)
          .length,
        sourceProviders.filter(
          (p) =>
            p.externalApis.length &&
            !/catch|failure|error/i.test(p.errorHandling),
        ).length,
      ]),
    );
  }
  lines.push("");
  lines.push("## Global Remaining Work Assessment", "");
  lines.push(
    "Priority 0: every action that reaches the v5 planner must return a structured `ActionResult` with `success`, and preferably `text` plus bounded `data`/`values` that can be appended to the trajectory context. Rows marked `return structured ActionResult`, `wrap external calls in failure result`, or `add native parameters` are the main blockers for reliable action-result stacking.",
  );
  lines.push("");
  lines.push(
    "Priority 1: every provider selected by a context should declare `cacheStable` and `cacheScope`, or explicitly document that it is turn-scoped and always refetched. Rows marked `declare cacheStable/cacheScope or cache policy` are cache-hit-rate blockers because their prompt segments cannot be reasoned about or diffed cleanly.",
  );
  lines.push("");
  lines.push(
    "Priority 2: every action and provider should have `contexts` or `contextGate`, and sensitive contexts need `roleGate`/validation gates. Rows marked `add context metadata` or `review permissive validation/role gate` are the main surface for context explosion and unauthorized tool exposure.",
  );
  lines.push("");
  lines.push(
    "Priority 3: external API providers/actions should show caps, pagination, truncation, retries, and error fallbacks. Rows marked `cap external results/timeouts` or `cap external/provider data` are likely to pollute the append-only context with unbounded payloads or fail without useful model-visible diagnostics.",
  );
  lines.push(
    "Priority 3 action cap rows are advisory when the action already returns structured success/failure and the cap lives behind a shared helper/service. Use them as review targets for append-only context size, not as hard blockers.",
  );
  lines.push("");
  lines.push("### Priority 3 action cap review by source", "");
  lines.push(row(["Source", "Rows"]));
  lines.push(row(["---", "---:"]));
  for (const [source, count] of countBy(actionCapReview, (a) => a.source)) {
    lines.push(row([source, count]));
  }
  lines.push("");
  lines.push("## Runtime Integration Gaps From Manual Audit", "");
  lines.push(
    "These are not per-action/provider defects, but they determine whether the rows below can actually append useful, cache-stable information to the v5 trajectory context.",
  );
  lines.push("");
  lines.push(
    "- Stage 1 no-context routing can still fall into planning when `contexts.length === 0` and `simple` is false or `reply` is empty. Fix `packages/core/src/runtime/message-handler.ts` and the `packages/core/src/services/message.ts` v5 seam so no-context turns either simple-reply, ignore/stop, or repair to a bounded clarification without planning.",
  );
  lines.push(
    "- Role-gated context semantics are incomplete. Stage 1 receives filtered context definitions, but selected contexts/actions are not post-filtered with user roles before exposure/execution. Wire roles through `filterByContextGate`, `executePlannedToolCall`, and the message service path.",
  );
  lines.push(
    "- `ContextObject` is still too thin for the plan. It records metadata/events, but not stable prefixes, trajectory prefixes, planned queue state, metrics, limits, or cache observations as first-class append-only state.",
  );
  lines.push(
    "- Planner/evaluator rendering still stringifies context/trajectory into prompt blobs instead of using byte-stable segment rendering. That blocks cache hit-rate science until `renderContextObject` and prefix hashing are production inputs.",
  );
  lines.push(
    "- Planned queue state is still sidecar/mutable. Queue pop, clear-on-continue, invalid recommendation, and replanning decisions should append canonical queue events to the context object.",
  );
  lines.push(
    "- `NEXT_RECOMMENDED` needs stricter semantics: select an already queued call by id, reject stale/invalid ids visibly, and avoid injecting a new tool outside the queue.",
  );
  lines.push(
    "- Tool execution should append canonical `tool_call`, `tool_result`, and `tool_error` context events, not only streaming hooks or local executor state.",
  );
  lines.push(
    "- Sub-actions are not yet exploded into top-level callable tools for selected contexts, and sub-planner aggregate results are not appended back to the parent context as one bounded `ActionResult`.",
  );
  lines.push(
    "- Cache observation/diff helpers exist but are not wired into planner/evaluator trajectory records. Segment hashes, prefix hashes, cache read/write tokens, and context diffs must be emitted for every model stage.",
  );
  lines.push(
    "- Streaming hooks exist but the main message service can run v5 with no active streaming sink, so tool/evaluation/context events may not reach chat UI surfaces.",
  );
  lines.push(
    "- Trajectory recorder/API/viewer shapes are split. v5 JSON recorder output and the existing DB/API viewer payloads need one canonical translation path before the trajectory viewer can be trusted.",
  );
  lines.push(
    "- Cloud bootstrap has native JSON parity improvements, but cloud still has separate message/bootstrap flows. Keep converging cloud on shared v5 Stage 1/planner/evaluator semantics instead of parallel prompt parsing.",
  );
  lines.push(
    "- Adapter support is partial. OpenAI/Anthropic/OpenRouter have native plumbing; other model plugins should either implement tools/messages/schema or fail explicitly behind a capability check.",
  );
  lines.push("");
  lines.push("## Action Inventory", "");
  lines.push(
    row([
      "Action",
      "Source",
      "Location",
      "Contexts / gates",
      "Validation",
      "Parameters",
      "Sub-actions",
      "External APIs",
      "Stack output",
      "Limits",
      "Error/success",
      "Cleanup",
    ]),
  );
  lines.push(
    row([
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
    ]),
  );
  for (const action of actions) {
    lines.push(
      row([
        action.name,
        action.source,
        relLink(action),
        action.contexts.join(", ") || action.contextGate || "-",
        `${action.validationKind}: ${action.validationDetail}`,
        action.parametersDeclared
          ? `${action.parameters.length} declared`
          : "-",
        action.subActions.join(", ") || "-",
        action.externalApis.join(", ") || "-",
        action.stackOutput,
        action.limits.join(", ") || "-",
        action.errorHandling,
        action.cleanup,
      ]),
    );
  }
  lines.push("");
  lines.push("## Provider Inventory", "");
  lines.push(
    row([
      "Provider",
      "Source",
      "Location",
      "Contexts / gates",
      "Cache policy",
      "External APIs",
      "Stack output",
      "Limits",
      "Error/success",
      "Cleanup",
    ]),
  );
  lines.push(
    row(["---", "---", "---", "---", "---", "---", "---", "---", "---", "---"]),
  );
  for (const provider of providers) {
    lines.push(
      row([
        provider.name,
        provider.source,
        relLink(provider),
        provider.contexts.join(", ") || provider.contextGate || "-",
        provider.cache,
        provider.externalApis.join(", ") || "-",
        provider.stackOutput,
        provider.limits.join(", ") || "-",
        provider.errorHandling,
        provider.cleanup,
      ]),
    );
  }
  lines.push("");
  lines.push("## Static Action Trees", "");
  lines.push("```text");
  lines.push(buildActionTrees(actions));
  lines.push("```", "");
  lines.push("## Hot Cleanup Buckets", "");
  const cleanupCounts = countBy(
    [...actions, ...providers],
    (record) => record.cleanup,
  );
  lines.push(row(["Cleanup assessment", "Count"]));
  lines.push(row(["---", "---:"]));
  for (const [cleanup, count] of cleanupCounts.slice(0, 60))
    lines.push(row([cleanup, count]));
  lines.push("");
  lines.push("## Action Output Details", "");
  lines.push(detailsSection("Action output and cleanup detail", actions));
  lines.push("");
  lines.push("## Provider Output Details", "");
  lines.push(detailsSection("Provider output and cleanup detail", providers));
  lines.push("");
  lines.push("## Scanner Notes", "");
  lines.push(
    "- `external APIs` is heuristic: direct HTTP calls, SDK/client calls, runtime services, LLM calls, database/memory, filesystem, shell, browser/device, and cache access are all tagged so reviewers can separate true third-party calls from internal services.",
  );
  lines.push(
    "- `always_refetch_or_runtime_cache_unknown` means the provider did not expose static cache metadata or obvious local cache calls. It may still be cached elsewhere by runtime composition, but that is not visible at the provider boundary.",
  );
  lines.push(
    "- `unknown/delegated` stack output usually means the action/provider returns a helper result or calls another service. Those rows need runtime review to verify the returned payload is bounded and trajectory-safe.",
  );
  lines.push(
    "- Dynamic MCP/search/tool factories are represented by their source action factory if statically visible; individual runtime-discovered tools are not enumerable from static source.",
  );
  return lines.join("\n");
}

const files = gitFiles();
const records = [];
for (const file of files) {
  try {
    records.push(...scanFile(file));
  } catch (error) {
    console.error(`Failed to scan ${file}:`, error);
  }
}

fs.writeFileSync(outFile, buildMarkdown(records, files.length));
console.log(
  `Wrote ${path.relative(repoRoot, outFile)} with ${records.filter((r) => r.kind === "action").length} actions and ${records.filter((r) => r.kind === "provider").length} providers.`,
);
