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
});
