/**
 * Guards the `packages/core/src/types` barrel against serving one exported name
 * from two different declarations.
 *
 * A plain `export *` collision raises TS2308, so it cannot survive review. But
 * the compiler's own suggested remedy — "Consider explicitly re-exporting to
 * resolve the ambiguity" — silences the diagnostic by making one side win
 * silently, and that is exactly how two structurally incompatible
 * `PendingUserAction` contracts (`types/task.ts` vs
 * `types/pending-user-action.ts`) coexisted behind a green typecheck. This test
 * asserts the property the compiler stops checking once a star becomes an
 * explicit list: across every module the barrel re-exports from, no exported
 * name resolves to more than one underlying declaration.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(currentDir, "../..");
const repoRoot = path.resolve(packageRoot, "../..");
const barrelRelativePath = "src/types/index.ts";
const barrelPath = path.join(packageRoot, barrelRelativePath);

/**
 * Exported names the barrel may legitimately serve from more than one
 * declaration, mapped to the reason. Empty by design: adding an entry means
 * someone decided two declarations of a single exported name are correct, and
 * has to say why in the diff that makes it so.
 */
const duplicateExportAllowlist = new Map<string, string>();

type Provider = {
	/** Module specifier as written in the barrel. */
	specifier: string;
	/** Files declaring the name, which is the identity we compare on. */
	declaredIn: string[];
};

function toRelativePath(filePath: string): string {
	return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function createBarrelProgram(): ts.Program {
	const configPath = path.join(packageRoot, "tsconfig.json");
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		packageRoot,
	);
	return ts.createProgram([barrelPath], {
		...parsed.options,
		noEmit: true,
		skipLibCheck: true,
	});
}

/**
 * Follows alias chains so that re-exporting one binding through several files
 * is not mistaken for a second declaration of the name.
 */
function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
	let current = symbol;
	const seen = new Set<ts.Symbol>();
	while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
		seen.add(current);
		const next = checker.getAliasedSymbol(current);
		if (next === current) break;
		current = next;
	}
	return current;
}

function declaringFiles(checker: ts.TypeChecker, symbol: ts.Symbol): string[] {
	const resolved = resolveAlias(checker, symbol);
	const files = new Set<string>();
	for (const declaration of resolved.declarations ?? []) {
		files.add(toRelativePath(declaration.getSourceFile().fileName));
	}
	return [...files].sort();
}

/** Every module the barrel re-exports from, star or explicit list alike. */
function reExportedModules(
	barrel: ts.SourceFile,
): { specifier: string; node: ts.StringLiteralLike }[] {
	const modules: { specifier: string; node: ts.StringLiteralLike }[] = [];
	for (const statement of barrel.statements) {
		if (!ts.isExportDeclaration(statement)) continue;
		const specifier = statement.moduleSpecifier;
		if (!specifier || !ts.isStringLiteralLike(specifier)) continue;
		modules.push({ specifier: specifier.text, node: specifier });
	}
	return modules;
}

function collectProvidersByName(): Map<string, Provider[]> {
	const program = createBarrelProgram();
	const checker = program.getTypeChecker();
	const barrel = program.getSourceFile(barrelPath);
	if (!barrel) {
		throw new Error(`Could not load ${barrelRelativePath} into the program`);
	}

	const providersByName = new Map<string, Provider[]>();
	for (const { specifier, node } of reExportedModules(barrel)) {
		const moduleSymbol = checker.getSymbolAtLocation(node);
		if (!moduleSymbol) continue;
		for (const exported of checker.getExportsOfModule(moduleSymbol)) {
			const name = exported.getName();
			if (name === "default") continue;
			const providers = providersByName.get(name) ?? [];
			providers.push({
				specifier,
				declaredIn: declaringFiles(checker, exported),
			});
			providersByName.set(name, providers);
		}
	}
	return providersByName;
}

function findCollisions(providersByName: Map<string, Provider[]>): string[] {
	const collisions: string[] = [];
	for (const [name, providers] of providersByName) {
		const identities = new Set(
			providers.map((provider) => provider.declaredIn.join(",")),
		);
		identities.delete("");
		if (identities.size < 2) continue;
		if (duplicateExportAllowlist.has(name)) continue;
		const detail = providers
			.filter((provider) => provider.declaredIn.length > 0)
			.map(
				(provider) =>
					`  - ${provider.specifier} -> ${provider.declaredIn.join(", ")}`,
			)
			.sort()
			.join("\n");
		collisions.push(`${name}\n${detail}`);
	}
	return collisions.sort();
}

describe("core types barrel export collisions", () => {
	it("serves every exported name from a single declaration", () => {
		expect(findCollisions(collectProvidersByName())).toEqual([]);
	}, 180_000);

	it("detects a collision that an explicit re-export list would mask", () => {
		const providersByName = new Map<string, Provider[]>([
			[
				"PendingUserAction",
				[
					{
						specifier: "./task",
						declaredIn: ["packages/core/src/types/task.ts"],
					},
					{
						specifier: "./pending-user-action",
						declaredIn: ["packages/core/src/types/pending-user-action.ts"],
					},
				],
			],
			[
				"ReExportedThroughTwoHops",
				[
					{ specifier: "./a", declaredIn: ["packages/core/src/types/z.ts"] },
					{ specifier: "./b", declaredIn: ["packages/core/src/types/z.ts"] },
				],
			],
		]);

		const collisions = findCollisions(providersByName);

		expect(collisions).toHaveLength(1);
		expect(collisions[0]).toContain("PendingUserAction");
		expect(collisions[0]).toContain("types/task.ts");
		expect(collisions[0]).toContain("types/pending-user-action.ts");
	});
});
