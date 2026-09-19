/**
 * Vitest config: aliases the `@elizaos/*` packages to their workspace sources and
 * runs the package's TypeScript and deterministic script-contract suites.
 * Real-FFI / real-model `*.real.test.ts` files run only in the post-merge lane
 * (`TEST_LANE=post-merge`).
 */

import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases";

export default defineConfig({
	resolve: {
		extensions: [".ts", ".tsx", ".mts", ".js", ".mjs", ".json"],
		alias: buildWorkspaceSourceAliases(),
	},
	test: {
		globals: true,
		environment: "node",
		// CI plugin shards run many packages concurrently on shared runners;
		// under that starvation the vitest 5s default fails healthy suites
		// (tts-cache N×N sweeps, GGUF fuzz passes). Explicit generous budget —
		// real hangs still fail, just later.
		testTimeout: 120_000,
		hookTimeout: 120_000,
		// I7/I8/I9 tests live next to their sources under `src/` (voice-budget,
		// device-tier, active-model co-locate `.test.ts` siblings). Keep the
		// `__tests__/**` glob for legacy suites and ALSO pick up co-located
		// `.test.ts` files under `src/` so they actually run via
		// `bun --filter @elizaos/plugin-local-inference verify`.
		include: [
			"__tests__/**/*.test.ts",
			"src/**/*.test.ts",
			"scripts/**/*.test.mjs",
			"native/verify/voice_duet_sweep.test.mjs",
		],
		exclude: [
			"dist/**",
			"node_modules/**",
			"**/*.e2e.test.ts",
			"**/*.live.test.ts",
			// Real-FFI / real-model tests (need a built libelizainference +
			// staged models) run ONLY in the post-merge lane, matching the
			// documented `TEST_LANE=post-merge bun run test`. They were excluded
			// unconditionally before, so the real STT/TTS lane ran nothing while
			// appearing green.
			...(process.env.TEST_LANE === "post-merge" ||
			process.env.VITEST_LANE === "post-merge"
				? []
				: ["**/*.real.test.ts"]),
		],
	},
});
