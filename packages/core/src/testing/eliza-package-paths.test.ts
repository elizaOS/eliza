/**
 * Verifies the test harness locates live workspace package sources without
 * depending on sibling build artifacts.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getUiSourceRoot } from "./eliza-package-paths.ts";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);

describe("workspace package source discovery", () => {
	it("resolves @elizaos/ui to packages/ui/src", () => {
		expect(realpathSync(getUiSourceRoot(repoRoot) ?? "")).toBe(
			realpathSync(path.join(repoRoot, "packages/ui/src")),
		);
	});
});
