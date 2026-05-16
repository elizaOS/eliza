// Integration test: run the eliza-side per-plugin manifest engine against
// THIS plugin's actual package.json + auto-enable.ts on disk. Proves end to
// end that the manifest engine reads our manifest, dynamic-imports our
// check module, and computes the correct verdict for each value of
// CLAUDE_MAX_PROXY_MODE.
//
// Why this matters: plugin-level unit tests for shouldEnable() prove the
// predicate logic, but they do not prove the engine can find or load our
// auto-enable module from package.json. This test crosses both surfaces.

import path from "node:path";

import { describe, expect, it } from "vitest";

import {
	evaluatePluginManifest,
	type PluginManifestCandidate,
} from "../../../packages/shared/src/config/plugin-manifest";

const candidate: PluginManifestCandidate = {
	packageName: "@elizaos/plugin-anthropic-proxy",
	packageRoot: path.resolve(__dirname, ".."),
};

function ctxFromEnv(env: Record<string, string | undefined>) {
	return { env, config: {}, isNativePlatform: false };
}

describe("manifest engine integration: plugin-anthropic-proxy", () => {
	it("reads the manifest and reports enabled=true for CLAUDE_MAX_PROXY_MODE=inline", async () => {
		const verdict = await evaluatePluginManifest(
			candidate,
			ctxFromEnv({ CLAUDE_MAX_PROXY_MODE: "inline" }),
		);
		expect(verdict).not.toBeNull();
		expect(verdict?.enabled).toBe(true);
		expect(verdict?.error).toBeNull();
	});

	it("reads the manifest and reports enabled=true for CLAUDE_MAX_PROXY_MODE=shared", async () => {
		const verdict = await evaluatePluginManifest(
			candidate,
			ctxFromEnv({ CLAUDE_MAX_PROXY_MODE: "shared" }),
		);
		expect(verdict?.enabled).toBe(true);
	});

	it("reads the manifest and reports enabled=false for CLAUDE_MAX_PROXY_MODE=off", async () => {
		const verdict = await evaluatePluginManifest(
			candidate,
			ctxFromEnv({ CLAUDE_MAX_PROXY_MODE: "off" }),
		);
		expect(verdict?.enabled).toBe(false);
		expect(verdict?.error).toBeNull();
	});

	it("reads the manifest and reports enabled=false when CLAUDE_MAX_PROXY_MODE is unset", async () => {
		const verdict = await evaluatePluginManifest(candidate, ctxFromEnv({}));
		expect(verdict?.enabled).toBe(false);
	});

	it("the manifest engine sees our package.json elizaos.plugin block (not null)", async () => {
		// If the manifest were missing or malformed, evaluate would return null.
		const verdict = await evaluatePluginManifest(candidate, ctxFromEnv({}));
		expect(verdict).not.toBeNull();
		expect(verdict?.error).toBeNull();
	});
});
