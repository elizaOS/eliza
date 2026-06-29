/**
 * Boundary guard for #9941: the innermost layer (`@elizaos/core`) must not
 * re-couple to concrete `@elizaos/plugin-*` packages.
 *
 * Two violations are enforced, both AST-classified so a plugin name mentioned
 * in a comment, an error message, or an action example (all legitimate) is not
 * miscounted:
 *
 *  1. **No plugin module imports.** `import`/`export … from`, dynamic
 *     `import()`, and `require()` of an `@elizaos/plugin-*` specifier point the
 *     dependency graph outward (Presentation/Infrastructure ← Domain), which
 *     violates "dependencies point inward only". Zero are allowed.
 *
 *  2. **No env-var → plugin "provider map" literal.** The specific dead,
 *     divergent copy this issue deleted (`buildCharacterPlugins`) was an object
 *     literal keyed by env-var names (`ANTHROPIC_API_KEY`, …) whose values were
 *     `@elizaos/plugin-*` names. That business rule lives in the `@elizaos/registry`
 *     generator now (`provider-plugin-map.json`); a fresh copy must not reappear
 *     in core. Detected structurally: an object literal with ≥2 UPPER_SNAKE_CASE
 *     keys whose values are plugin-name string literals.
 *
 * A `pluginName: "@elizaos/plugin-openai"` field (camelCase key — the first-run
 * options contract) and an action-example `text: "install @elizaos/plugin-discord"`
 * are intentionally NOT flagged: they are data/UX, not a connector business rule
 * or a module dependency.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const CORE_SRC = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

const PLUGIN_SPECIFIER = /^@elizaos\/plugin-[a-z0-9-]+$/;
const PLUGIN_NAME_LITERAL =
	/@elizaos\/plugin-[a-z0-9-]+|(?:^|[^a-z])plugin-[a-z0-9-]+/;
const ENV_KEY = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function isTestLikeFile(rel: string): boolean {
	if (/\.d\.ts$/.test(rel)) return true;
	if (/\.(test|spec|e2e|stories?|fixture|mock)\.(ts|tsx)$/.test(rel)) {
		return true;
	}
	const segments = rel.split(path.sep);
	// `testing/` ships first-party test utilities that legitimately print
	// example `import … from '@elizaos/plugin-sql'` snippets and live-provider
	// fixtures; it is not production runtime code and is excluded.
	return segments.some((seg) =>
		["__tests__", "__mocks__", "__fixtures__", "testing", "test"].includes(seg),
	);
}

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listSourceFiles(full));
			continue;
		}
		if (!/\.(ts|tsx)$/.test(entry.name)) continue;
		const rel = path.relative(CORE_SRC, full);
		if (isTestLikeFile(rel)) continue;
		out.push(full);
	}
	return out;
}

function literalText(node: ts.Node): string | undefined {
	if (ts.isStringLiteralLike(node)) return node.text;
	return undefined;
}

interface Violation {
	file: string;
	line: number;
	kind: "import" | "provider-map";
	detail: string;
}

function classify(relPath: string, sourceText: string): Violation[] {
	const sourceFile = ts.createSourceFile(
		relPath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const violations: Violation[] = [];
	const at = (node: ts.Node) =>
		sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
		1;

	const recordImport = (spec: ts.Expression | undefined) => {
		if (!spec) return;
		const text = literalText(spec);
		if (text && PLUGIN_SPECIFIER.test(text)) {
			violations.push({
				file: relPath,
				line: at(spec),
				kind: "import",
				detail: text,
			});
		}
	};

	const isProviderMap = (obj: ts.ObjectLiteralExpression): boolean => {
		let envKeyedPluginValues = 0;
		for (const prop of obj.properties) {
			if (!ts.isPropertyAssignment(prop)) continue;
			const key = prop.name;
			const keyText = ts.isIdentifier(key)
				? key.text
				: ts.isStringLiteralLike(key)
					? key.text
					: undefined;
			if (!keyText || !ENV_KEY.test(keyText)) continue;
			const value = literalText(prop.initializer);
			if (value && PLUGIN_NAME_LITERAL.test(value)) {
				envKeyedPluginValues += 1;
			}
		}
		return envKeyedPluginValues >= 2;
	};

	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			recordImport(node.moduleSpecifier as ts.Expression | undefined);
		}
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require"))
		) {
			recordImport(node.arguments[0]);
		}
		if (ts.isObjectLiteralExpression(node) && isProviderMap(node)) {
			violations.push({
				file: relPath,
				line: at(node),
				kind: "provider-map",
				detail: "env-var → @elizaos/plugin-* object literal",
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return violations;
}

describe("core plugin-coupling boundary (#9941)", () => {
	const files = listSourceFiles(CORE_SRC);

	it("scans a non-trivial slice of core production source", () => {
		expect(files.length).toBeGreaterThan(50);
	});

	it("never imports a concrete @elizaos/plugin-* package", () => {
		const offenders = files.flatMap((file) =>
			classify(
				path.relative(CORE_SRC, file),
				readFileSync(file, "utf8"),
			).filter((v) => v.kind === "import"),
		);
		expect(
			offenders,
			`@elizaos/core must not import @elizaos/plugin-* (dependencies point inward):\n${offenders
				.map((v) => `  ${v.file}:${v.line} ${v.detail}`)
				.join("\n")}`,
		).toEqual([]);
	});

	it("never hosts an env-var → plugin provider map (no fresh buildCharacterPlugins)", () => {
		const offenders = files.flatMap((file) =>
			classify(
				path.relative(CORE_SRC, file),
				readFileSync(file, "utf8"),
			).filter((v) => v.kind === "provider-map"),
		);
		expect(
			offenders,
			`The provider env→plugin map is owned by @elizaos/registry; it must not be copied into core:\n${offenders
				.map((v) => `  ${v.file}:${v.line} ${v.detail}`)
				.join("\n")}`,
		).toEqual([]);
	});

	it("flags a deliberately-added plugin import and provider map (self-check)", () => {
		const bad = classify(
			"synthetic.ts",
			[
				`import anthropic from "@elizaos/plugin-anthropic";`,
				`const m = await import("@elizaos/plugin-openai");`,
				`const MAP = {`,
				`  ANTHROPIC_API_KEY: "@elizaos/plugin-anthropic",`,
				`  OPENAI_API_KEY: "@elizaos/plugin-openai",`,
				`};`,
			].join("\n"),
		);
		expect(bad.filter((v) => v.kind === "import")).toHaveLength(2);
		expect(bad.filter((v) => v.kind === "provider-map")).toHaveLength(1);
	});

	it("does not flag legitimate data contracts or action examples (self-check)", () => {
		const ok = classify(
			"synthetic.ts",
			[
				`// install @elizaos/plugin-discord to enable Discord`,
				`const option = { pluginName: "@elizaos/plugin-openai", label: "OpenAI" };`,
				`const example = { text: "install @elizaos/plugin-discord" };`,
				`const deps = { dependencies: ["@elizaos/plugin-sql"] };`,
			].join("\n"),
		);
		expect(ok).toEqual([]);
	});
});
