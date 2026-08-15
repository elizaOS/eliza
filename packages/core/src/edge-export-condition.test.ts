/**
 * Clean-source regression for the `@elizaos/core/edge` export (#20010):
 * the `eliza-source` condition must resolve the canonical edge source entry
 * (`src/index.edge.ts`) without `packages/core/dist` existing, while the
 * distribution conditions stay unchanged. The resolution is exercised in a
 * real `node` child process because custom export conditions are a
 * resolver-level contract, not an alias layer.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
	readFileSync(join(packageRoot, "package.json"), "utf8"),
) as {
	exports: Record<string, Record<string, unknown>>;
};

function resolveWithConditions(conditions: string[]): string {
	const script = `
		const { createRequire } = require("node:module");
		const req = createRequire(${JSON.stringify(join(packageRoot, "package.json"))});
		process.stdout.write(req.resolve("@elizaos/core/edge", { conditions: new Set(${JSON.stringify(conditions)}) }));
	`;
	return execFileSync("node", ["-e", script], { encoding: "utf8" });
}

describe("@elizaos/core/edge export conditions (#20010)", () => {
	it("resolves the canonical edge source entry under eliza-source without dist", () => {
		const resolved = resolveWithConditions(["eliza-source"]).replace(/\\/g, "/");
		expect(resolved).toContain("packages/core/src/index.edge.ts");
		expect(resolved).not.toContain("/dist/");
	});

	it("keeps the distribution conditions unchanged", () => {
		const edge = pkg.exports["./edge"];
		expect(edge.types).toBe("./dist/edge/index.d.ts");
		expect(edge.import).toBe("./dist/edge/index.edge.js");
		expect(edge.default).toBe("./dist/edge/index.edge.js");
		const source = edge["eliza-source"] as Record<string, string>;
		expect(source.types).toBe("./src/index.edge.ts");
		expect(source.import).toBe("./src/index.edge.ts");
		expect(source.default).toBe("./src/index.edge.ts");
	});
});
