/**
 * Guards the invariant that core's `./testing` export carries no reverse import
 * edge into `@elizaos/agent` (#12091 item 6): greps the harness source for
 * import specifiers and asserts the injected-option shape. Deterministic — no
 * runtime or model involved.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	createRealTestRuntime,
	type RealTestRuntimeOptions,
} from "./real-runtime.ts";

// #12091 item 6: the core `./testing` export used to reach into
// `packages/agent/src` via relative dynamic imports
// (`../../../agent/src/runtime/eliza`, `.../trajectory-storage`) with variable
// specifiers, hiding a reverse core->agent edge that silently degrades outside
// the monorepo checkout. The agent-owned helpers are now INJECTED options.
// These guard the invariant structurally (grep-in-a-test) so the edge cannot
// creep back, and assert the injected-option shape callers rely on.
const testingDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testingDir, "../..");

const HARNESS_FILES = ["real-runtime.ts", "pglite-runtime.ts"] as const;
const CORE_PACKAGE_FILES = [
	...HARNESS_FILES.map((file) => `src/testing/${file}`),
	"test/helpers/pglite-runtime.ts",
] as const;

function importSpecifiers(source: string): string[] {
	const importSpecifier =
		/(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g;
	return [...source.matchAll(importSpecifier)].map((match) => match[1]);
}

describe("core ./testing has no reverse edge into @elizaos/agent (#12091 item 6)", () => {
	for (const file of HARNESS_FILES) {
		it(`${file} imports nothing from packages/agent`, () => {
			const source = fs.readFileSync(path.join(testingDir, file), "utf8");
			// Match only import/require contexts (static `from "…"`, dynamic
			// `import("…")`, `require("…")`) so the doc-comments explaining WHY the
			// edge is gone don't self-trip the guard. No specifier may resolve into
			// the sibling agent package by relative path or by `@elizaos/agent`.
			for (const specifier of importSpecifiers(source)) {
				expect(specifier).not.toMatch(/\.\.\/\.\.\/\.\.\/agent/);
				expect(specifier).not.toMatch(/^@elizaos\/agent(?:\/|$)/);
			}
		});
	}

	it("keeps core-package runtime helpers free of agent imports", () => {
		for (const file of CORE_PACKAGE_FILES) {
			const source = fs.readFileSync(path.join(packageRoot, file), "utf8");
			for (const specifier of importSpecifiers(source)) {
				expect(specifier).not.toMatch(/\.\.\/\.\.\/\.\.\/agent/);
				expect(specifier).not.toMatch(/^@elizaos\/agent(?:\/|$)/);
			}
		}
	});

	it("accepts an injected flushTrajectoryWrites instead of importing it", () => {
		const flushTrajectoryWrites: RealTestRuntimeOptions["flushTrajectoryWrites"] =
			async () => {};
		const options: RealTestRuntimeOptions = { flushTrajectoryWrites };
		// Type-level contract: the injected host helpers are part of the options.
		expect(options.flushTrajectoryWrites).toBe(flushTrajectoryWrites);
		expect(typeof createRealTestRuntime).toBe("function");
	});

	it("accepts an injected configureEmbeddingPlugin instead of importing it", () => {
		const calls: string[] = [];
		const options: RealTestRuntimeOptions = {
			configureEmbeddingPlugin: (plugin) => {
				calls.push(plugin.name);
			},
		};
		options.configureEmbeddingPlugin?.({ name: "embed", description: "x" });
		expect(calls).toEqual(["embed"]);
	});
});
