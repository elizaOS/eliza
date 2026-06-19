import { readFileSync } from "node:fs";
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
});
