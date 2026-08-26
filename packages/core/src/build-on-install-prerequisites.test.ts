/**
 * Contract: every workspace dependency that core's Node bundle inlines must be
 * built before core during install.
 *
 * `bun install` runs `packages/scripts/build-private-workspace-packages.mjs`,
 * which builds the packages declaring `elizaos.scripts.buildOnInstall` in
 * ascending `order`. Core's build marks only the specifiers in its build
 * config's `external` list as runtime imports; every other workspace
 * dependency is inlined, and a `target: "node"` bundle resolves those through
 * the plain `node`/`import` conditions — which for these packages point into
 * `dist/`. An inlined dependency whose `dist/` nothing builds first fails
 * core's build and aborts the entire postinstall, so a fresh
 * `git clone && bun install` exits non-zero before a contributor runs anything.
 *
 * The harness is real: the assertions read the checked-in workspace manifests
 * and the build config core actually ships. Nothing here is mocked.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveBuildOnInstallPackages } from "../../scripts/lib/script-metadata.mjs";
import { listPackages } from "../../scripts/lib/workspaces.mjs";
import { createElizaBuildConfig } from "../build";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);

const CORE_PACKAGE_NAME = "@elizaos/core";

/** `@elizaos/plugin-*` entries match by prefix; every other entry is exact. */
function matchesExternal(specifier: string, pattern: string): boolean {
	return pattern.endsWith("*")
		? specifier.startsWith(pattern.slice(0, -1))
		: specifier === pattern;
}

/**
 * The `.` target a `target: "node"` bundler selects. The `bun` and
 * `eliza-source` conditions are inactive for that target, so resolution falls
 * through to `node` / `import` / `default` — the conditions that decide whether
 * a dependency is consumed from source or from a built `dist/`.
 */
function nodeConditionEntry(
	manifest: Record<string, unknown>,
): string | undefined {
	const walk = (value: unknown): string | undefined => {
		if (typeof value === "string") return value;
		if (!value || typeof value !== "object") return undefined;
		for (const condition of ["node", "import", "default"]) {
			const resolved = walk((value as Record<string, unknown>)[condition]);
			if (resolved !== undefined) return resolved;
		}
		return undefined;
	};
	const exports = manifest.exports;
	const dot =
		exports && typeof exports === "object"
			? (exports as Record<string, unknown>)["."]
			: undefined;
	const resolved = walk(dot);
	if (resolved !== undefined) return resolved;
	return typeof manifest.main === "string" ? manifest.main : undefined;
}

function resolvesFromBuiltDist(entry: string): boolean {
	return entry.replace(/^\.\//, "").startsWith("dist/");
}

describe("core install-time build prerequisites", () => {
	it("builds every inlined workspace dependency before core", async () => {
		const manifestsByName = new Map(
			listPackages({ repoRoot: REPO_ROOT })
				.filter((pkg) => typeof pkg.name === "string")
				.map((pkg) => [pkg.name as string, pkg.packageJson]),
		);

		const orderByName = new Map(
			resolveBuildOnInstallPackages({ repoRoot: REPO_ROOT }).map((pkg) => [
				pkg.name,
				pkg.order,
			]),
		);

		const coreOrder = orderByName.get(CORE_PACKAGE_NAME);
		expect(
			coreOrder,
			`${CORE_PACKAGE_NAME} must declare elizaos.scripts.buildOnInstall so install builds it`,
		).toBeTypeOf("number");

		const coreManifest = manifestsByName.get(CORE_PACKAGE_NAME);
		expect(
			coreManifest,
			`${CORE_PACKAGE_NAME} must be a workspace package`,
		).toBeDefined();

		const externals =
			(
				await createElizaBuildConfig({
					target: "node",
					selfPackageName: CORE_PACKAGE_NAME,
				})
			).external ?? [];

		const dependencies = (coreManifest as Record<string, unknown>).dependencies;
		const declared =
			dependencies && typeof dependencies === "object"
				? (dependencies as Record<string, string>)
				: {};

		const violations: string[] = [];
		for (const [dependency, range] of Object.entries(declared)) {
			if (!String(range).startsWith("workspace:")) continue;
			// External specifiers stay runtime imports: the bundler never resolves
			// them, so their dist is not an install-time prerequisite.
			if (externals.some((pattern) => matchesExternal(dependency, pattern))) {
				continue;
			}
			const manifest = manifestsByName.get(dependency);
			if (!manifest) continue;
			const entry = nodeConditionEntry(manifest);
			// Source-resolved dependencies need no build to be importable.
			if (!entry || !resolvesFromBuiltDist(entry)) continue;

			const order = orderByName.get(dependency);
			if (order === undefined || order >= (coreOrder as number)) {
				violations.push(
					`${dependency} resolves to ${entry} but is ${
						order === undefined
							? "not declared buildOnInstall"
							: `built at order ${order}, not before core (order ${coreOrder})`
					}`,
				);
			}
		}

		expect(
			violations,
			"Inlined workspace dependencies missing from the install-time build order; a fresh `bun install` will fail while building @elizaos/core",
		).toEqual([]);
	});
});
