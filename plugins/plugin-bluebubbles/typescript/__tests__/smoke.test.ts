import { describe, expect, it } from "vitest";

describe("@elizaos/plugin-bluebubbles", () => {
	it("exports the plugin", { timeout: 60_000 }, async () => {
		const mod = await import("../src/index.ts");
		expect(mod).toBeDefined();
	});
});
