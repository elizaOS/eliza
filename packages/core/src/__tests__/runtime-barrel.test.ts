/**
 * Guards the `@elizaos/core` public barrel: keeps test helpers out of the
 * package root, ensures first-run provider value re-exports stay present, and
 * asserts the filesystem-probing plugin-loader is absent. Reads the source
 * files as text and asserts on their contents.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(sourceRoot, "..");

describe("@elizaos/core runtime barrel", () => {
	it("keeps test helpers out of the package root", () => {
		for (const relativePath of ["index.node.ts", "types/index.ts"]) {
			const source = readFileSync(resolve(sourceRoot, relativePath), "utf8");

			expect(source).not.toMatch(/export\s+\*\s+from\s+["']\.\/testing["']/);
		}
	});

	it("re-exports first-run provider helpers consumed as runtime values (#12794)", () => {
		// dist/contracts/ ships .d.ts only (contracts are not build entrypoints),
		// so runtime consumers (e.g. app-core's credential-resolver) must import
		// these VALUES from the barrel; the "@elizaos/core/contracts/*" subpath
		// resolves to a non-existent .js and breaks `bun run dev` boot.
		const barrel = readFileSync(resolve(sourceRoot, "index.node.ts"), "utf8");
		const firstRunExport = barrel.match(
			/export\s*\{([^}]*)\}\s*from\s*["']\.\/contracts\/first-run-options["']/,
		);

		expect(firstRunExport).not.toBeNull();
		for (const name of [
			"getDirectAccountProviderForFirstRunProvider",
			"getFirstRunProviderOption",
			"getStoredFirstRunProviderId",
			"normalizeFirstRunProviderId",
		]) {
			expect(firstRunExport?.[1]).toContain(name);
		}
	});

	it("does not ship the filesystem-probing plugin-loader (workspace probing is host/CLI concern)", () => {
		// The loader that probed sibling packages' unbuilt src/ trees and imported
		// them by variable specifier is gone; core resolves plugins only through
		// injected Plugin objects or a host-provided PluginResolver.
		expect(existsSync(resolve(sourceRoot, "utils/plugin-loader.ts"))).toBe(
			false,
		);

		const barrel = readFileSync(resolve(sourceRoot, "index.node.ts"), "utf8");
		expect(barrel).not.toMatch(/plugin-loader/);
	});

	it("publishes the explicit Cloudflare Workers runtime entry", () => {
		const manifest = JSON.parse(
			readFileSync(resolve(packageRoot, "package.json"), "utf8"),
		) as {
			exports?: Record<string, { import?: string; types?: string }>;
		};
		const edge = manifest.exports?.["./edge"];

		expect(edge?.import).toBe("./dist/edge/index.edge.js");
		expect(edge?.types).toBe("./dist/edge/index.d.ts");
		expect(edge).not.toHaveProperty("eliza-source");
	});

	it("binds the edge barrel and declarations to the edge capability surface", () => {
		const barrel = readFileSync(resolve(sourceRoot, "index.edge.ts"), "utf8");

		expect(barrel).toContain(
			'export * from "./features/basic-capabilities/index.edge";',
		);
		expect(barrel).not.toMatch(
			/export\s+\*\s+from\s+["']\.\/features\/basic-capabilities\/index["']/,
		);
	});

	it("keeps the document parser graph out of the edge artifact (#21327)", () => {
		// `mammoth`/`unpdf` are already external for this target, but external only
		// leaves a bare specifier in the artifact — it does not remove the parser
		// entry points. The edge build aliases the one module that imports them to
		// a throwing stub, so the shipped artifact carries neither specifier.
		const buildScript = readFileSync(resolve(packageRoot, "build.ts"), "utf8");
		expect(buildScript).toMatch(
			/filter:\s*\/\^\\\.\\\/parsers\(\?:\\\.ts\|\\\.js\)\?\$\//,
		);
		expect(buildScript).toContain("src/features/documents/parsers.edge.ts");

		// utils.ts must reach the parsers through ./parsers so the importer-scoped
		// alias covers every consumer; the pure helpers beside them stay live on
		// edge and must NOT move into the stubbed module.
		const utils = readFileSync(
			resolve(sourceRoot, "features/documents/utils.ts"),
			"utf8",
		);
		expect(utils).toMatch(
			/export\s*\{[^}]*convertPdfToTextFromBuffer[^}]*\}\s*from\s*["']\.\/parsers\.ts["']/s,
		);
		expect(utils).toContain("export function normalizeDocumentContentType");

		const artifact = resolve(packageRoot, "dist/edge/index.edge.js");
		if (!existsSync(artifact)) return;
		const edgeBundle = readFileSync(artifact, "utf8");
		expect(edgeBundle).not.toContain('import("unpdf")');
		expect(edgeBundle).not.toContain('import("mammoth")');
	});
});
