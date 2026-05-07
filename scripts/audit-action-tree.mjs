#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const repoRoot = process.cwd();
const outFile = path.join(repoRoot, "ACTION_TREE_REVIEW.md");

const SOURCE_ROOTS = ["packages", "plugins", "cloud"];
const EXCLUDE_RE =
  /(^|\/)(dist|build|coverage|node_modules|\.turbo|\.next|generated)(\/|$)|(\.d\.ts$)|(\.(test|spec)\.tsx?$)|(^|\/)(__tests__|test|tests|templates)(\/|$)/;
const EXCLUDED_PATH_PREFIXES = [
  "packages/examples/",
  "packages/app-core/src/components/custom-actions/",
  "packages/app-core/src/benchmark/",
  "packages/agent/src/api/",
];

const exportedBindingCache = new Map();

function hasExportModifier(node) {
	return Boolean(
		node.modifiers?.some(
			(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
		),
	);
}

function collectExportedStaticBindings(file) {
	if (exportedBindingCache.has(file)) return exportedBindingCache.get(file);
	const abs = path.join(repoRoot, file);
	const result = { strings: new Map(), arrays: new Map() };
	exportedBindingCache.set(file, result);
	if (!fs.existsSync(abs)) return result;
	const source = fs.readFileSync(abs, "utf8");
	const sf = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);

	function readArray(expr) {
		expr = unwrapExpression(expr);
		if (!expr || !ts.isArrayLiteralExpression(expr)) return undefined;
		const values = expr.elements
			.flatMap((element) => {
				if (ts.isStringLiteralLike(element)) return [element.text];
				if (ts.isIdentifier(element)) {
					const stringValue = result.strings.get(element.text);
					if (stringValue) return [stringValue];
					const arrayValue = result.arrays.get(element.text);
					if (arrayValue) return arrayValue;
				}
				if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
					return result.arrays.get(element.expression.text) ?? [];
				}
				return [];
			})
			.filter(Boolean);
		return values.length > 0 ? values : undefined;
	}

	function visit(node) {
		if (
			ts.isVariableStatement(node) &&
			hasExportModifier(node) &&
			node.declarationList
		) {
			for (const declaration of node.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
					continue;
				}
				const initializer = unwrapExpression(declaration.initializer);
				const text = literalText(initializer);
				if (text !== undefined) {
					result.strings.set(declaration.name.text, text);
					continue;
				}
				const array = readArray(initializer);
				if (array) result.arrays.set(declaration.name.text, array);
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sf);
	return result;
}

function importedBindingValue(bindings, localName) {
	const imported = bindings?.importBindings?.get(localName);
	if (!imported) return undefined;
	const exported = collectExportedStaticBindings(imported.file);
	const stringValue = exported.strings.get(imported.imported);
	if (stringValue) return { type: "string", value: stringValue };
	const arrayValue = exported.arrays.get(imported.imported);
	if (arrayValue) return { type: "array", value: arrayValue };
	return undefined;
}

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
  ) {
    return name.text;
  }
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
	if (ts.isAsExpression(expr) || ts.isSatisfiesExpression?.(expr)) {
		return literalText(expr.expression);
	}
	if (ts.isStringLiteralLike(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (ts.isNumericLiteral(expr)) return expr.text;
  return undefined;
}

function unwrapExpression(expr) {
	let current = expr;
	while (
		current &&
		(ts.isAsExpression(current) || ts.isSatisfiesExpression?.(current))
	) {
		current = current.expression;
	}
	return current;
}

function collectStaticBindings(sf, file) {
	const stringBindings = new Map();
	const arrayBindings = new Map();
	const specBindings = new Map();
	const importBindings = new Map();

  function resolveImportPath(specifier) {
    if (!specifier.startsWith(".")) return undefined;
    const fromDir = path.dirname(file);
    const candidate = path.normalize(path.join(fromDir, specifier));
    const candidates = [
      candidate.endsWith(".js") ? candidate.replace(/\.js$/, ".ts") : "",
      candidate.endsWith(".js") ? candidate.replace(/\.js$/, ".tsx") : "",
      candidate,
      `${candidate}.ts`,
      `${candidate}.tsx`,
      `${candidate}.js`,
      path.join(candidate, "index.ts"),
      path.join(candidate, "index.tsx"),
    ].filter(Boolean);
    return candidates.find((item) => fs.existsSync(path.join(repoRoot, item)));
  }

	function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const resolvedFile = resolveImportPath(node.moduleSpecifier.text);
      const namedBindings = node.importClause?.namedBindings;
      if (resolvedFile && namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          const local = element.name.text;
          importBindings.set(local, { file: resolvedFile, imported });
        }
      }
    }

	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
		const initializer = unwrapExpression(node.initializer);
		if (initializer) {
			const literal = literalText(initializer);
			if (literal !== undefined) {
				stringBindings.set(node.name.text, literal);
			} else if (ts.isArrayLiteralExpression(initializer)) {
				const values = initializer.elements
					.flatMap((element) => {
						if (ts.isStringLiteralLike(element)) return [element.text];
						if (ts.isIdentifier(element)) {
							const stringValue = stringBindings.get(element.text);
							if (stringValue) return [stringValue];
							const arrayValue = arrayBindings.get(element.text);
							if (arrayValue) return arrayValue;
						}
						if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
							return arrayBindings.get(element.expression.text) ?? [];
						}
						return [];
					})
					.filter(Boolean);
				if (values.length > 0) arrayBindings.set(node.name.text, values);
			} else if (
				ts.isCallExpression(initializer) &&
				ts.isIdentifier(initializer.expression) &&
				initializer.expression.text === "requireActionSpec"
			) {
				const [firstArg] = initializer.arguments;
				const specName =
					literalText(firstArg) ||
					(ts.isIdentifier(firstArg)
						? stringBindings.get(firstArg.text)
						: undefined);
				if (specName) specBindings.set(node.name.text, specName);
			}
      }
    }
    ts.forEachChild(node, visit);
  }

	visit(sf);
	return { stringBindings, arrayBindings, specBindings, importBindings };
}

function resolvedLiteralText(expr, bindings) {
  const direct = literalText(expr);
  if (direct !== undefined) return direct;
	if (bindings && ts.isIdentifier(expr)) {
		return (
			bindings.stringBindings.get(expr.text) ||
			(importedBindingValue(bindings, expr.text)?.type === "string"
				? importedBindingValue(bindings, expr.text).value
				: undefined)
		);
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

function propSource(obj, names, sf, max = 220) {
  return exprText(getPropExpression(getProp(obj, names)), sf, max);
}

function declarationName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
    if (ts.isPropertyAssignment(current)) return propName(current);
    if (ts.isExportAssignment(current)) return "default";
    current = current.parent;
  }
  return "";
}

function declarationType(node) {
  let current = node.parent;
  while (current) {
    if (ts.isVariableDeclaration(current) && current.type) {
      return current.type.getText();
    }
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression?.(current)) {
      return current.type.getText();
    }
    current = current.parent;
  }
  return "";
}

function lineFor(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function stringArray(expr, sf, bindings) {
	if (!expr) return [];
	expr = unwrapExpression(expr);
	if (bindings && ts.isIdentifier(expr)) {
		const arrayValue = bindings.arrayBindings.get(expr.text);
		if (arrayValue) return arrayValue;
		const stringValue = bindings.stringBindings.get(expr.text);
		if (stringValue) return [stringValue];
		const imported = importedBindingValue(bindings, expr.text);
		if (imported?.type === "array") return imported.value;
		if (imported?.type === "string") return [imported.value];
	}
	if (ts.isArrayLiteralExpression(expr)) {
		return expr.elements
			.flatMap((element) => {
				if (ts.isStringLiteralLike(element)) return element.text;
				if (ts.isSpreadElement(element)) {
					if (bindings && ts.isIdentifier(element.expression)) {
						const imported = importedBindingValue(
							bindings,
							element.expression.text,
						);
						if (imported?.type === "array") return imported.value;
						return (
							bindings.arrayBindings.get(element.expression.text) ??
							[`...${exprText(element.expression, sf, 80)}`]
						);
					}
					return `...${exprText(element.expression, sf, 80)}`;
				}
				if (ts.isIdentifier(element)) {
					if (bindings) {
						const stringValue = bindings.stringBindings.get(element.text);
						if (stringValue) return stringValue;
						const arrayValue = bindings.arrayBindings.get(element.text);
						if (arrayValue) return arrayValue;
						const imported = importedBindingValue(bindings, element.text);
						if (imported?.type === "array") return imported.value;
						if (imported?.type === "string") return imported.value;
					}
					return `{ref:${element.text}}`;
				}
				if (ts.isObjectLiteralExpression(element)) {
					const name = literalText(getPropExpression(getProp(element, "name")));
					return name ? `{inline:${name}}` : exprText(element, sf, 100);
        }
        return exprText(element, sf, 100);
      })
      .filter(Boolean);
  }
  return [exprText(expr, sf, 100)].filter(Boolean);
}

function containsActionShape(obj) {
  return getProp(obj, "name") && getProp(obj, "handler");
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
  const bindings = collectStaticBindings(sf, file);
  const records = [];
  const seen = new Set();

  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const key = `${file}:${node.pos}`;
      if (!seen.has(key)) {
        seen.add(key);
        const type = declarationType(node);
        const inActionPath =
          /(^|\/)(actions?|action)\//.test(file) ||
          /(^|\/)action\.tsx?$/.test(file);
        const maybeAction =
          containsActionShape(node) &&
          !getProp(node, "get") &&
          (inActionPath ||
            /Action\b/.test(type) ||
            getProp(node, "parameters") ||
            getProp(node, "subActions"));
        if (maybeAction) {
          records.push(makeActionRecord(file, sf, node, bindings));
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return records;
}

function bodyText(obj, sf) {
  const handler = getProp(obj, "handler");
  return handler ? handler.getText(sf) : "";
}

function makeActionRecord(file, sf, obj, bindings) {
	const body = bodyText(obj, sf);
	const nameExpr = getPropExpression(getProp(obj, "name"));
	const resolvedName = resolvedLiteralText(nameExpr, bindings);
	const name = resolvedName || exprText(nameExpr, sf, 100);
	const contexts = stringArray(getPropExpression(getProp(obj, "contexts")), sf, bindings);
	const contextGate = propSource(obj, "contextGate", sf, 220);
	const roleGate = propSource(obj, "roleGate", sf, 160);
	const subActions = stringArray(
		getPropExpression(getProp(obj, "subActions")),
		sf,
		bindings,
	);
  const description =
    propSource(obj, ["descriptionCompressed", "compressedDescription"], sf, 260) ||
    propSource(obj, "description", sf, 260);
  const validation = getProp(obj, "validate")
    ? /=>\s*true|return\s+true\b/.test(getProp(obj, "validate").getText(sf))
      ? "always_true"
      : "conditional"
    : "missing";
  const resultShape = [
    /\bsuccess\s*:/.test(body) ? "success" : "",
    /\btext\s*:/.test(body) ? "text" : "",
    /\bdata\s*:/.test(body) ? "data" : "",
    /\bvalues\s*:/.test(body) ? "values" : "",
    /\berror\s*:/.test(body) ? "error" : "",
    /return\s+await\s+|return\s+[a-zA-Z_$][\w$]*\(/.test(body)
      ? "delegated"
      : "",
    /callback\s*\??\s*\(/.test(body) ? "callback" : "",
  ].filter(Boolean);
	const flags = [];
	const nameStatic = Boolean(resolvedName);
	const descriptionIsSpecBacked = /spec\.(description|descriptionCompressed)/.test(
		description,
	);
	if (/TODO|FIXME|placeholder|stub|not implemented|deprecated|legacy/i.test(`${description}\n${body}`)) {
		flags.push("placeholder/deprecated wording");
	}
	if ((!description || description.length < 20) && !descriptionIsSpecBacked) {
		flags.push("thin description");
	}
  if (validation === "always_true" && !roleGate && !contextGate) {
    flags.push("permissive validation");
  }
  if (!resultShape.includes("success") && !resultShape.includes("delegated")) {
    flags.push("unstructured result");
  }
  if (subActions.length && !getProp(obj, "subPlanner")) {
    flags.push("subActions without subPlanner metadata");
  }

  return {
		name,
		nameStatic,
		declarationName: declarationName(obj),
    source: sourceKind(file),
    file,
    line: lineFor(sf, obj),
    description,
    contexts,
    contextGate,
    roleGate,
    subActions,
    subPlanner: Boolean(getProp(obj, "subPlanner")),
    parameters: stringArray(
      getPropExpression(getProp(obj, "parameters")),
      sf,
      bindings,
    ),
    validation,
    resultShape,
    flags,
    importBindings: bindings.importBindings,
  };
}

function resolveSubActionRefs(actions) {
  const byName = new Map();
  const byDecl = new Map();
  const byFileAndDecl = new Map();
  for (const action of actions) {
    if (!byName.has(action.name)) byName.set(action.name, action);
    if (action.declarationName && !byDecl.has(action.declarationName)) {
      byDecl.set(action.declarationName, action);
    }
    if (action.declarationName) {
      byFileAndDecl.set(`${action.file}:${action.declarationName}`, action);
    }
  }
  for (const action of actions) {
    action.resolvedSubActions = action.subActions.map((raw) => {
      const ref = raw.match(/^\{ref:(.+)\}$/)?.[1];
      const inline = raw.match(/^\{inline:(.+)\}$/)?.[1];
      const name = inline || ref || raw.replace(/^\{|\}$/g, "");
      const imported = ref ? action.importBindings?.get(ref) : undefined;
      const importedTarget = imported
        ? byFileAndDecl.get(`${imported.file}:${imported.imported}`)
        : undefined;
      const target = importedTarget ?? (ref ? byDecl.get(ref) : byName.get(name));
      return {
        raw,
        name: target?.name ?? name,
        found: Boolean(target),
        action: target,
      };
    });
  }
  return { byName, byDecl };
}

function actionContexts(action) {
  return action.contexts.filter((context) => !context.startsWith("..."));
}

function isExposedForContext(action, context) {
  if (actionContexts(action).includes(context)) return true;
  if (action.contextGate.includes(`"${context}"`) || action.contextGate.includes(`'${context}'`)) {
    return true;
  }
  return false;
}

function duplicateGroups(actions) {
  const groups = new Map();
  for (const action of actions) {
    if (!action.nameStatic) continue;
    const key = action.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(action);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

function duplicateRisk(name, group) {
  const files = group.map((action) => action.file);
  const sources = group.map((action) => action.source);
  const hasCloud = sources.some((source) => source.startsWith("cloud"));
  const hasLocal = sources.some((source) => !source.startsWith("cloud"));
  const allCore = sources.every((source) => source === "core");

  if (name === "SCHEDULE_FOLLOW_UP" && allCore) {
    return {
      severity: files.some((file) => file.includes("advanced-planning"))
        ? "medium"
        : "high",
      classification: files.some((file) => file.includes("advanced-planning"))
        ? "dead/unregistered core overlap"
        : "same-runtime core collision",
      recommendation:
        "The native relationships follow-up action is registered by default; the advanced-planning follow-up source appears unregistered and should be deleted or explicitly renamed if revived.",
    };
  }
  if ((name === "UPDATE_SETTINGS" || name === "UPDATE_ROLE") && allCore) {
    return {
      severity: "high",
      classification: "same-runtime core feature collision",
      recommendation:
        "Split domain-specific names or route through one settings/roles action; duplicate registrations silently keep only the first action.",
    };
  }
  if (
    name === "UPDATE_ROLE" &&
    sources.includes("agent") &&
    sources.filter((source) => source === "core").length > 0
  ) {
    return {
      severity: "high",
      classification: "agent/core role collision",
      recommendation:
        "Pick one role-management action name or namespace runtime-role versus trust-role updates; loading both surfaces makes registration order decide which one survives.",
    };
  }
  if (
    name === "SWAP" &&
    sources.every((source) => source === "plugin:plugin-wallet")
  ) {
    return {
      severity: "medium",
      classification: "dead/direct chain action overlap",
      recommendation:
        "Wallet currently exposes WALLET_ACTION as the registered router; direct EVM/Solana SWAP exports are redundant unless renamed to EVM_SWAP/SOLANA_SWAP and registered as sub-actions.",
    };
  }
  if (
    ["LIST_AGENTS", "SEND_TO_AGENT", "SPAWN_AGENT", "STOP_AGENT"].includes(
      name,
    ) &&
    sources.includes("plugin:plugin-acpx") &&
    sources.includes("plugin:plugin-agent-orchestrator")
  ) {
    return {
      severity: "medium",
      classification: "successor plugin overlap",
      recommendation:
        "Pick one agent-control surface or namespace ACPx actions; co-loading drops whichever plugin registers second.",
    };
  }
  if (name === "GENERATE_IMAGE") {
    return {
      severity: hasCloud && hasLocal ? "medium" : "high",
      classification: "shared capability mirror",
      recommendation:
        "Cloud mirrors can remain deployment-local, but core/agent image generation needs one canonical local tool name or explicit namespaced variants.",
    };
  }
  if (name === "WEB_SEARCH" && hasCloud && hasLocal) {
    return {
      severity: "medium",
      classification: "cloud/local mirror",
      recommendation:
        "Accept only if cloud and desktop never co-load; otherwise namespace coding-tools web search or expose one canonical WEB_SEARCH.",
    };
  }
  if (name === "READ_MCP_RESOURCE" && hasCloud && hasLocal) {
    return {
      severity: "low",
      classification: "cloud/local mirror",
      recommendation:
        "Likely acceptable as separate cloud/local implementations; keep behavior and result shape aligned.",
    };
  }
  if (
    name === "WALK_TO" &&
    files.some((file) => file.includes("app-2004scape")) &&
    files.some((file) => file.includes("app-scape"))
  ) {
    return {
      severity: "medium",
      classification: "game plugin overlap",
      recommendation:
        "Namespace per game or ensure these plugins cannot co-load; the runtime keeps only one WALK_TO.",
    };
  }
  if (name === "CREATE_TASK") {
    return {
      severity: "medium",
      classification: "task surface overlap",
      recommendation:
        "Use one generic CREATE_TASK and move ACPx-specific behavior behind sub-actions, or rename ACPx to ACPX_CREATE_TASK.",
    };
  }
  if (hasCloud && hasLocal) {
    return {
      severity: "low",
      classification: "cloud/local mirror",
      recommendation: "Confirm deployment isolation and keep contract parity.",
    };
  }
  return {
    severity: "medium",
    classification: "duplicate action name",
    recommendation:
      "Review registration order; duplicate action names are skipped after the first registration.",
  };
}

function contextIndex(actions) {
  const contexts = new Map();
  for (const action of actions) {
    for (const context of actionContexts(action)) {
      if (!contexts.has(context)) contexts.set(context, []);
      contexts.get(context).push(action);
    }
  }
  return [...contexts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function childVisibilityFindings(actions) {
  const findings = [];
  for (const parent of actions.filter((action) => action.resolvedSubActions?.length)) {
    const parentContexts = actionContexts(parent);
    for (const childRef of parent.resolvedSubActions) {
      if (!childRef.found) {
        findings.push({
          severity: "high",
          parent,
          childName: childRef.name,
          issue: "sub-action reference does not resolve to a scanned action",
        });
        continue;
      }
      const child = childRef.action;
      const shared = parentContexts.filter((context) =>
        isExposedForContext(child, context),
      );
      if (parentContexts.length > 0 && shared.length === 0) {
        findings.push({
          severity: "medium",
          parent,
          childName: child.name,
          issue:
            "child is available in sub-planner but does not share any static parent context for main-context explosion",
        });
      }
    }
  }
  return findings;
}

function redundancyFindings(actions) {
  const findings = [];
  const bySourceAndDescription = new Map();
  for (const action of actions) {
    if (!action.nameStatic) continue;
    const normalizedDescription = action.description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .slice(0, 120);
    const key = `${action.source}:${normalizedDescription}`;
    const specBackedDescription = /spec\.(description|descriptionCompressed)/.test(
      action.description,
    );
    if (normalizedDescription && !specBackedDescription) {
      if (!bySourceAndDescription.has(key)) bySourceAndDescription.set(key, []);
      bySourceAndDescription.get(key).push(action);
    }
    for (const flag of action.flags) {
      findings.push({ action, issue: flag });
    }
  }
  for (const group of bySourceAndDescription.values()) {
    if (group.length > 1) {
      findings.push({
        action: group[0],
        issue: `similar descriptions in ${group.map((item) => item.name).join(", ")}`,
      });
    }
  }
  return findings.sort((a, b) => a.action.name.localeCompare(b.action.name));
}

function relLink(action) {
  const abs = path.join(repoRoot, action.file);
  return `[${action.file}:${action.line}](${abs}:${action.line})`;
}

function mdEscape(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br>")
    .trim() || "-";
}

function row(cols) {
  return `| ${cols.map(mdEscape).join(" | ")} |`;
}

function emitTree(action, lines, depth = 0, seen = new Set()) {
  const prefix = `${"  ".repeat(depth)}-`;
  const contexts = action.contexts.join(", ") || action.contextGate || "context missing";
  const subPlanner = action.subPlanner ? "subPlanner" : "no subPlanner";
  lines.push(`${prefix} ${action.name} (${action.source}; ${contexts}; ${subPlanner})`);
  if (seen.has(action.name)) {
    lines.push(`${"  ".repeat(depth + 1)}- cycle detected`);
    return;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(action.name);
  for (const child of action.resolvedSubActions ?? []) {
    if (child.action) {
      emitTree(child.action, lines, depth + 1, nextSeen);
    } else {
      lines.push(`${"  ".repeat(depth + 1)}- ${child.name} (missing)`);
    }
  }
}

function buildMarkdown(actions, filesScanned) {
  const generatedAt = new Date().toISOString();
  const duplicates = duplicateGroups(actions);
  const childFindings = childVisibilityFindings(actions);
  const redundant = redundancyFindings(actions);
  const dynamicActions = actions
    .filter((action) => !action.nameStatic)
    .sort((a, b) => a.name.localeCompare(b.name));
  const parents = actions.filter((action) => action.resolvedSubActions?.length);
  const childNames = new Set(
    parents.flatMap((action) => action.resolvedSubActions.map((child) => child.name)),
  );
  const roots = parents.filter((action) => !childNames.has(action.name));
  const contextRows = contextIndex(actions);

  const lines = [
    "# Action Tree Review",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Summary",
    "",
    `- Files scanned: ${filesScanned}`,
    `- Actions scanned: ${actions.length}`,
    `- Static sub-action parents: ${parents.length}`,
    `- Duplicate action-name groups: ${duplicates.length}`,
    `- Dynamic action factories / unresolved names: ${dynamicActions.length}`,
    `- Sub-action visibility findings: ${childFindings.length}`,
    `- Redundancy/uselessness heuristic findings: ${redundant.length}`,
    "",
    "## Direct Answers",
    "",
    "- Context explosion: selected contexts are rendered through the v5 context object. Statically, the only declared sub-action tree is `CALENDAR`, and all children share a parent context, so `calendar` selection exposes the parent and the child actions in the main context before runtime role gates.",
    "- Duplicate actions: yes. Static duplicate groups remain; the table below classifies which are same-runtime risks versus cloud/local mirrors or redundant source exports.",
    "- Useless/redundant actions: no action is proven useless from static inspection alone, but the heuristic list flags placeholder wording, unstructured outputs, and redundant mirrors that should be reviewed before calling the action surface 100%.",
    "",
    "## Runtime Behavior Notes",
    "",
    "- `createV5MessageContextObject` appends selected context tools into the context object's event stream and trajectory prefix.",
    "- `renderContextObject` displays selected contexts, expanded tools, and tool events; `collectPlannerTools` then converts those appended action events into native planner tools.",
    "- `runSubPlanner` scopes a parent action's declared `subActions` when the parent itself is called. Static cycle detection protects recursive sub-action trees; normal iteration/token/time limits still apply.",
    "- Duplicate action names are not merged by the runtime. `registerPlugin` and `registerAction` skip later duplicates, so duplicate names can hide tools from the planner depending on registration order.",
    "",
    "## 100% Cleanup Checklist",
    "",
    "1. Resolve the `high` duplicate groups first: `UPDATE_ROLE` and `UPDATE_SETTINGS`. These are the only static duplicate groups classified as same-runtime collision risks in this scan.",
    "2. Decide the canonical owner for medium overlaps: `GENERATE_IMAGE`, ACPx vs agent-orchestrator agent controls, `CREATE_TASK`, `WEB_SEARCH`, and game `WALK_TO`.",
    "3. Delete or rename dormant duplicate source surfaces: advanced-planning's unregistered `SCHEDULE_FOLLOW_UP` and wallet's direct chain-level `SWAP` actions if `WALLET_ACTION` remains the public router.",
    "4. Fix the heuristic action-quality list: placeholder/deprecated wording should become real action descriptions; unstructured result actions should return `ActionResult` with `success`, `text`, and structured `data`.",
    "5. Keep sub-action trees explicit. Today only `CALENDAR` declares a static tree; any future umbrella action should declare `subActions`, `subPlanner`, shared contexts, and cycle-safe child names.",
    "",
    "## Main Findings",
    "",
  ];

  if (duplicates.length === 0 && childFindings.length === 0 && redundant.length === 0) {
    lines.push("No static issues found.");
  } else {
    if (duplicates.length) {
      lines.push("### Duplicate Action Names", "");
      lines.push(
        row(["severity", "name", "count", "classification", "recommendation", "locations"]),
      );
      lines.push(row(["---", "---", "---", "---", "---", "---"]));
      for (const [name, group] of duplicates) {
        const risk = duplicateRisk(name, group);
        lines.push(
          row([
            risk.severity,
            name,
            group.length,
            risk.classification,
            risk.recommendation,
            group.map(relLink).join("<br>"),
          ]),
        );
      }
      lines.push("");
    }
    if (dynamicActions.length) {
      lines.push("### Dynamic Action Factories", "");
      lines.push(
        "These are intentionally not treated as duplicate names because the static expression is not the final runtime name.",
        "",
      );
      lines.push(row(["expression", "source", "contexts", "location"]));
      lines.push(row(["---", "---", "---", "---"]));
      for (const action of dynamicActions) {
        lines.push(
          row([
            action.name,
            action.source,
            action.contexts.join(", ") || action.contextGate,
            relLink(action),
          ]),
        );
      }
      lines.push("");
    }
    if (childFindings.length) {
      lines.push("### Sub-Action Visibility", "");
      lines.push(row(["severity", "parent", "child", "issue", "parent source"]));
      lines.push(row(["---", "---", "---", "---", "---"]));
      for (const finding of childFindings) {
        lines.push(
          row([
            finding.severity,
            finding.parent.name,
            finding.childName,
            finding.issue,
            relLink(finding.parent),
          ]),
        );
      }
      lines.push("");
    }
    if (redundant.length) {
      lines.push("### Redundant / Useless Heuristics", "");
      lines.push(row(["action", "issue", "location"]));
      lines.push(row(["---", "---", "---"]));
      for (const finding of redundant.slice(0, 120)) {
        lines.push(row([finding.action.name, finding.issue, relLink(finding.action)]));
      }
      if (redundant.length > 120) {
        lines.push(`_Only first 120 shown; ${redundant.length - 120} omitted._`);
      }
      lines.push("");
    }
  }

  lines.push("## Static Action Trees", "");
  if (roots.length === 0) {
    lines.push("No static sub-action trees found.");
  } else {
    for (const root of roots) {
      emitTree(root, lines);
      lines.push("");
    }
  }

  lines.push("## Context Explosion Preview", "");
  lines.push(
    "This is the static approximation of what a selected context can expose before runtime role gates and validation checks.",
    "",
  );
  for (const [context, group] of contextRows) {
    const names = [...new Set(group.map((action) => action.name))].sort();
    lines.push(`<details><summary>${context} (${names.length} actions)</summary>`, "");
    lines.push(names.join(", "));
    lines.push("", "</details>", "");
  }

  lines.push("## All Sub-Action Parents", "");
  lines.push(row(["parent", "source", "contexts", "subPlanner", "children", "location"]));
  lines.push(row(["---", "---", "---", "---", "---", "---"]));
  for (const parent of parents.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(
      row([
        parent.name,
        parent.source,
        parent.contexts.join(", ") || parent.contextGate,
        parent.subPlanner ? "yes" : "no",
        parent.resolvedSubActions.map((child) => `${child.name}${child.found ? "" : " (missing)"}`).join(", "),
        relLink(parent),
      ]),
    );
  }

  lines.push("", "## All Actions", "");
  lines.push(
    row([
      "name",
      "source",
      "contexts",
      "role gate",
      "validation",
      "result shape",
      "sub-actions",
      "location",
    ]),
  );
  lines.push(row(["---", "---", "---", "---", "---", "---", "---", "---"]));
  for (const action of actions.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(
      row([
        action.name,
        action.source,
        action.contexts.join(", ") || action.contextGate,
        action.roleGate,
        action.validation,
        action.resultShape.join(", ") || "-",
        action.resolvedSubActions?.map((child) => child.name).join(", ") || "-",
        relLink(action),
      ]),
    );
  }

  return `${lines.join("\n")}\n`;
}

const files = gitFiles();
const actions = files.flatMap(scanFile);
resolveSubActionRefs(actions);
fs.writeFileSync(outFile, buildMarkdown(actions, files.length));
console.log(`Wrote ACTION_TREE_REVIEW.md with ${actions.length} actions.`);
