import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ENTRY_URL = new URL("../index.node.ts", import.meta.url);
const DIST_ENTRY_URL = new URL(
	"../../dist/node/index.node.js",
	import.meta.url,
);
const EXPLICIT_EVALUATOR_EXPORT_SNIPPET = `export {
	factExtractorEvaluator,
	skillExtractionEvaluator,
	skillRefinementEvaluator,
} from "./features/advanced-capabilities/evaluators/index";`;

describe("@elizaos/core node entry contract", () => {
	it("keeps advanced evaluators explicit in the source node entry", async () => {
		const source = await readFile(SOURCE_ENTRY_URL, "utf8");

		expect(source).toContain(EXPLICIT_EVALUATOR_EXPORT_SNIPPET);
	});

	it("exports advanced evaluators from the built node bundle when dist exists", async () => {
		const distEntryPath = fileURLToPath(DIST_ENTRY_URL);

		if (!existsSync(distEntryPath)) {
			return;
		}

		const distEntry = await import(DIST_ENTRY_URL.href);

		expect(distEntry.skillRefinementEvaluator).toBeDefined();
		expect(distEntry.skillExtractionEvaluator).toBeDefined();
		expect(distEntry.factExtractorEvaluator).toBeDefined();
	}, 60000);
});
