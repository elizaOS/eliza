import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type { IAgentRuntime } from "../types/runtime";
import { Service, ServiceType } from "../types/service";

type SourceInfo = {
	filePath: string;
	relativePath: string;
	sourceFile: ts.SourceFile;
	localConstants: Map<string, string>;
};

type ServiceClassRegistration = {
	className: string;
	filePath: string;
	relativePath: string;
	serviceType: string;
};

type AllowlistEntry = {
	reason: string;
	classes: Set<string>;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../../..");
const scanRoots = ["packages/core/src", "packages/agent/src", "plugins"];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const ignoredDirectoryNames = new Set([
	".turbo",
	"build",
	"coverage",
	"dist",
	"e2e",
	"generated",
	"node_modules",
	"test",
	"test-results",
	"tests",
	"__tests__",
]);
const ignoredFileFragments = [".d.ts", ".test.", ".spec."];
const serviceTypeValuesByMember = new Map(
	Object.entries(ServiceType).map(([key, value]) => [key, String(value)]),
);

const duplicateServiceTypeAllowlist = new Map<string, AllowlistEntry>([
	[
		"trajectories",
		{
			reason:
				"Core and agent intentionally register trajectory services side by side; callers resolve the full implementation with getServicesByType().",
			classes: new Set([
				"packages/core/src/features/trajectories/TrajectoriesService.ts:TrajectoriesService",
				"packages/agent/src/runtime/trajectory-storage.ts:DatabaseTrajectoryLogger",
			]),
		},
	],
	[
		"discord-local",
		{
			reason:
				"Discord local exists as an agent legacy mirror and an extracted plugin during migration; both export the same plugin/service contract and must not be enabled together.",
			classes: new Set([
				"packages/agent/src/runtime/discord-local-plugin.ts:DiscordLocalService",
				"plugins/plugin-discord/discord-local-service.ts:DiscordLocalService",
			]),
		},
	],
]);
let cachedServiceClassRegistrations: ServiceClassRegistration[] | null = null;

class CollisionTestServiceA extends Service {
	static override serviceType = "collision-test";
	capabilityDescription = "collision test service A";

	static override async start(
		runtime: IAgentRuntime,
	): Promise<CollisionTestServiceA> {
		return new CollisionTestServiceA(runtime);
	}

	async stop(): Promise<void> {}
}

class CollisionTestServiceB extends Service {
	static override serviceType = "collision-test";
	capabilityDescription = "collision test service B";

	static override async start(
		runtime: IAgentRuntime,
	): Promise<CollisionTestServiceB> {
		return new CollisionTestServiceB(runtime);
	}

	async stop(): Promise<void> {}
}

function toRelativePath(filePath: string): string {
	return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function shouldIgnoreFile(filePath: string): boolean {
	const baseName = path.basename(filePath);
	return ignoredFileFragments.some((fragment) => baseName.includes(fragment));
}

function collectSourceFiles(root: string): string[] {
	const absoluteRoot = path.join(repoRoot, root);
	const files: string[] = [];

	function walk(directory: string): void {
		for (const entry of readdirSync(directory)) {
			const fullPath = path.join(directory, entry);
			const stat = statSync(fullPath);
			if (stat.isDirectory()) {
				if (!ignoredDirectoryNames.has(entry)) {
					walk(fullPath);
				}
				continue;
			}
			if (
				stat.isFile() &&
				sourceExtensions.has(path.extname(fullPath)) &&
				!shouldIgnoreFile(fullPath)
			) {
				files.push(fullPath);
			}
		}
	}

	walk(absoluteRoot);
	return files;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function literalStringValue(expression: ts.Expression): string | null {
	const unwrapped = unwrapExpression(expression);
	if (
		ts.isStringLiteral(unwrapped) ||
		ts.isNoSubstitutionTemplateLiteral(unwrapped)
	) {
		return unwrapped.text;
	}
	return null;
}

function collectLocalConstants(sourceFile: ts.SourceFile): Map<string, string> {
	const constants = new Map<string, string>();

	function visit(node: ts.Node): void {
		if (
			ts.isVariableStatement(node) &&
			(node.declarationList.flags & ts.NodeFlags.Const) !== 0
		) {
			for (const declaration of node.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
					continue;
				}
				const value = literalStringValue(declaration.initializer);
				if (value) {
					constants.set(declaration.name.text, value);
				}
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return constants;
}

function getUniqueGlobalConstants(sources: SourceInfo[]): Map<string, string> {
	const valuesByName = new Map<string, Set<string>>();
	for (const source of sources) {
		for (const [name, value] of source.localConstants) {
			const values = valuesByName.get(name) ?? new Set<string>();
			values.add(value);
			valuesByName.set(name, values);
		}
	}

	const unique = new Map<string, string>();
	for (const [name, values] of valuesByName) {
		if (values.size === 1) {
			unique.set(name, [...values][0]);
		}
	}
	return unique;
}

function resolveServiceTypeInitializer(
	expression: ts.Expression,
	localConstants: Map<string, string>,
	globalConstants: Map<string, string>,
): string | null {
	const unwrapped = unwrapExpression(expression);
	const literal = literalStringValue(unwrapped);
	if (literal) {
		return literal;
	}

	if (ts.isPropertyAccessExpression(unwrapped)) {
		const objectName = unwrapped.expression.getText();
		if (objectName === "ServiceType") {
			return serviceTypeValuesByMember.get(unwrapped.name.text) ?? null;
		}
	}

	if (ts.isIdentifier(unwrapped)) {
		return (
			localConstants.get(unwrapped.text) ??
			globalConstants.get(unwrapped.text) ??
			null
		);
	}

	return null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return Boolean(
		ts.canHaveModifiers(node) &&
			ts.getModifiers(node)?.some((modifier) => modifier.kind === kind),
	);
}

function isStaticMember(node: ts.ClassElement): boolean {
	return hasModifier(node, ts.SyntaxKind.StaticKeyword);
}

function hasStaticStart(classNode: ts.ClassDeclaration): boolean {
	return classNode.members.some(
		(member) =>
			ts.isMethodDeclaration(member) &&
			isStaticMember(member) &&
			ts.isIdentifier(member.name) &&
			member.name.text === "start",
	);
}

function extendsService(classNode: ts.ClassDeclaration): boolean {
	return Boolean(
		classNode.heritageClauses?.some((clause) => {
			if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
				return false;
			}
			return clause.types.some((type) => {
				const baseName = type.expression.getText();
				return baseName === "Service" || baseName.endsWith(".Service");
			});
		}),
	);
}

function getStaticServiceTypeInitializer(
	classNode: ts.ClassDeclaration,
): ts.Expression | null {
	for (const member of classNode.members) {
		if (
			ts.isPropertyDeclaration(member) &&
			isStaticMember(member) &&
			ts.isIdentifier(member.name) &&
			member.name.text === "serviceType" &&
			member.initializer
		) {
			return member.initializer;
		}
	}
	return null;
}

function collectServiceClassRegistrations(): ServiceClassRegistration[] {
	if (cachedServiceClassRegistrations) {
		return cachedServiceClassRegistrations;
	}

	const files = scanRoots.flatMap(collectSourceFiles);
	const sources: SourceInfo[] = files.map((filePath) => {
		const sourceText = ts.sys.readFile(filePath) ?? "";
		const sourceFile = ts.createSourceFile(
			filePath,
			sourceText,
			ts.ScriptTarget.Latest,
			true,
		);
		return {
			filePath,
			relativePath: toRelativePath(filePath),
			sourceFile,
			localConstants: collectLocalConstants(sourceFile),
		};
	});
	const globalConstants = getUniqueGlobalConstants(sources);
	const registrations: ServiceClassRegistration[] = [];

	for (const source of sources) {
		function visit(node: ts.Node): void {
			if (
				ts.isClassDeclaration(node) &&
				node.name &&
				!hasModifier(node, ts.SyntaxKind.AbstractKeyword) &&
				extendsService(node) &&
				hasStaticStart(node)
			) {
				const initializer = getStaticServiceTypeInitializer(node);
				const serviceType = initializer
					? resolveServiceTypeInitializer(
							initializer,
							source.localConstants,
							globalConstants,
						)
					: null;
				if (serviceType) {
					registrations.push({
						className: node.name.text,
						filePath: source.filePath,
						relativePath: source.relativePath,
						serviceType,
					});
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(source.sourceFile);
	}

	cachedServiceClassRegistrations = registrations;
	return registrations;
}

function classId(registration: ServiceClassRegistration): string {
	return `${registration.relativePath}:${registration.className}`;
}

function groupByServiceType(
	registrations: ServiceClassRegistration[],
): Map<string, ServiceClassRegistration[]> {
	const groups = new Map<string, ServiceClassRegistration[]>();
	for (const registration of registrations) {
		const group = groups.get(registration.serviceType) ?? [];
		group.push(registration);
		groups.set(registration.serviceType, group);
	}
	return groups;
}

function isAllowlistedDuplicate(
	serviceType: string,
	group: ServiceClassRegistration[],
): boolean {
	const allowlist = duplicateServiceTypeAllowlist.get(serviceType);
	if (!allowlist) {
		return false;
	}
	const actual = new Set(group.map(classId));
	if (actual.size !== allowlist.classes.size) {
		return false;
	}
	return [...actual].every((id) => allowlist.classes.has(id));
}

function formatDuplicateGroup(
	serviceType: string,
	group: ServiceClassRegistration[],
): string {
	const classes = group
		.map((registration) => `  - ${classId(registration)}`)
		.join("\n");
	return `${serviceType}\n${classes}`;
}

function expectServiceType(
	registrations: ServiceClassRegistration[],
	classIdentifier: string,
	serviceType: string,
): void {
	const registration = registrations.find(
		(candidate) => classId(candidate) === classIdentifier,
	);
	expect(registration?.serviceType).toBe(serviceType);
}

describe("serviceType collision guardrails", () => {
	it("warns when dynamic service registration makes getService ambiguous", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const warnSpy = vi
			.spyOn(runtime.logger, "warn")
			.mockImplementation(() => undefined);

		await runtime.registerService(CollisionTestServiceA);
		await runtime.registerService(CollisionTestServiceB);

		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				serviceType: "collision-test",
				serviceClass: "CollisionTestServiceB",
			}),
			expect.stringContaining("Duplicate serviceType registration"),
		);
		warnSpy.mockRestore();
	});

	it("warns when plugin service declarations reuse a serviceType", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const warnSpy = vi
			.spyOn(runtime.logger, "warn")
			.mockImplementation(() => undefined);

		await runtime.registerPlugin({
			name: "collision-test-plugin",
			description: "Plugin with duplicate service types",
			services: [CollisionTestServiceA, CollisionTestServiceB],
		});

		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				plugin: "collision-test-plugin",
				serviceType: "collision-test",
				serviceClass: "CollisionTestServiceB",
			}),
			expect.stringContaining("Duplicate serviceType registration"),
		);
		warnSpy.mockRestore();
	});

	it("keeps service class serviceType values unique unless explicitly allowlisted", () => {
		const registrations = collectServiceClassRegistrations();
		const groups = groupByServiceType(registrations);
		const unexpectedDuplicateGroups = [...groups.entries()]
			.filter(([, group]) => group.length > 1)
			.filter(
				([serviceType, group]) => !isAllowlistedDuplicate(serviceType, group),
			)
			.map(([serviceType, group]) => formatDuplicateGroup(serviceType, group));

		expect(unexpectedDuplicateGroups).toEqual([]);
	}, 180_000);

	it("keeps known collision fixes in place", () => {
		const registrations = collectServiceClassRegistrations();
		const groups = groupByServiceType(registrations);

		expect(groups.get("FORM")?.map(classId)).toEqual([
			"plugins/plugin-form/src/service.ts:FormService",
		]);
		expectServiceType(
			registrations,
			"plugins/plugin-tailscale/src/services/LocalTailscaleService.ts:LocalTailscaleService",
			"tunnel:local",
		);
		expectServiceType(
			registrations,
			"plugins/plugin-tailscale/src/services/CloudTailscaleService.ts:CloudTailscaleService",
			"tunnel:cloud",
		);
		expectServiceType(
			registrations,
			"packages/core/src/features/trust/services/TrustEngine.ts:TrustEngine",
			"trust-engine:core",
		);
		expectServiceType(
			registrations,
			"packages/core/src/features/trust/services/wrappers.ts:TrustEngineServiceWrapper",
			"trust-engine",
		);
		expectServiceType(
			registrations,
			"packages/core/src/features/trust/services/CredentialProtector.ts:CredentialProtector",
			"credential-protector:core",
		);
		expectServiceType(
			registrations,
			"packages/core/src/features/trust/services/wrappers.ts:CredentialProtectorServiceWrapper",
			"credential-protector",
		);
	});
});
