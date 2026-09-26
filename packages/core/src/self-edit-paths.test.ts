/** Preserve tooling exclusions for source and installed script artifacts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSelfEditEnabled, isSelfEditPathDenied } from "./self-edit";

afterEach(() => vi.unstubAllEnvs());

describe("self-edit host environment", () => {
	it("requires opt-in and preserves production gating", () => {
		vi.stubEnv("ELIZA_ENABLE_SELF_EDIT", "1");
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("ELIZA_DEV_MODE", "0");
		expect(isSelfEditEnabled()).toBe(false);
		vi.stubEnv("ELIZA_DEV_MODE", "1");
		expect(isSelfEditEnabled()).toBe(true);
		vi.stubEnv("ELIZA_ENABLE_SELF_EDIT", "0");
		expect(isSelfEditEnabled()).toBe(false);
		expect(
			isSelfEditEnabled({
				ELIZA_ENABLE_SELF_EDIT: "1",
				NODE_ENV: "development",
			}),
		).toBe(true);
		expect(isSelfEditEnabled({})).toBe(false);
	});
});

describe("self-edit tooling paths", () => {
	it.each([
		"/workspace/packages/app/scripts/run-node.ts",
		"/workspace/packages/app/scripts/run-node.mjs",
		"/consumer/node_modules/@elizaos/app/dist/scripts/run-node.mjs",
		"C:\\consumer\\node_modules\\@elizaos\\app\\dist\\scripts\\run-node.mjs",
	])("protects %s", (file) => {
		expect(isSelfEditPathDenied(file)).toBe(true);
	});
	it("allows ordinary source edits", () => {
		expect(isSelfEditPathDenied("/workspace/src/run-node-example.ts")).toBe(
			false,
		);
	});
});
