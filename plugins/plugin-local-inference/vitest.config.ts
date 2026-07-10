/**
 * Vitest config: aliases the `@elizaos/*` packages to their workspace sources and
 * runs both the legacy `__tests__/**` suites and the co-located `src/**`
 * `.test.ts` siblings. Real-FFI / real-model `*.real.test.ts` files run only in
 * the post-merge lane (`TEST_LANE=post-merge`).
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		extensions: [".ts", ".tsx", ".mts", ".js", ".mjs", ".json"],
		alias: {
			"@elizaos/core": fileURLToPath(
				new URL("../../packages/core/src/index.node.ts", import.meta.url),
			),
			// Core's source entry re-exports the cloud-routing package. A clean
			// workspace has not built that package's dist entry yet, so source-mode
			// tests must keep this transitive dependency on the source graph too.
			"@elizaos/cloud-routing": fileURLToPath(
				new URL("../../packages/cloud/routing/src/index.ts", import.meta.url),
			),
			"@elizaos/logger": fileURLToPath(
				new URL("../../packages/logger/src/index.ts", import.meta.url),
			),
			"@elizaos/agent": fileURLToPath(
				new URL("../../packages/agent/src/index.ts", import.meta.url),
			),
			// Deep subpath must precede the bare alias — the bare entry
			// prefix-matches and would rewrite this to `src/index.ts/<subpath>`.
			"@elizaos/plugin-capacitor-bridge/mobile-device-bridge-bootstrap":
				fileURLToPath(
					new URL(
						"../plugin-capacitor-bridge/src/mobile-device-bridge-bootstrap.ts",
						import.meta.url,
					),
				),
			"@elizaos/plugin-capacitor-bridge": fileURLToPath(
				new URL("../plugin-capacitor-bridge/src/index.ts", import.meta.url),
			),
			"@elizaos/plugin-computeruse": fileURLToPath(
				new URL("../plugin-computeruse/src/index.ts", import.meta.url),
			),
			"@elizaos/shared/local-inference/routing-preferences": fileURLToPath(
				new URL(
					"../../packages/shared/src/local-inference/routing-preferences.ts",
					import.meta.url,
				),
			),
			"@elizaos/shared/local-inference/verify": fileURLToPath(
				new URL(
					"../../packages/shared/src/local-inference/verify.ts",
					import.meta.url,
				),
			),
			"@elizaos/shared/local-inference": fileURLToPath(
				new URL(
					"../../packages/shared/src/local-inference/index.ts",
					import.meta.url,
				),
			),
			"@elizaos/shared/voice/voice-cancellation-token": fileURLToPath(
				new URL(
					"../../packages/shared/src/voice/voice-cancellation-token.ts",
					import.meta.url,
				),
			),
			"@elizaos/shared/voice/respond-gate": fileURLToPath(
				new URL(
					"../../packages/shared/src/voice/respond-gate.ts",
					import.meta.url,
				),
			),
			"@elizaos/shared/voice/owner-inference": fileURLToPath(
				new URL(
					"../../packages/shared/src/voice/owner-inference.ts",
					import.meta.url,
				),
			),
			"@elizaos/shared/voice/aec": fileURLToPath(
				new URL(
					"../../packages/shared/src/voice/aec/index.ts",
					import.meta.url,
				),
			),
			"@elizaos/shared/voice-wer": fileURLToPath(
				new URL("../../packages/shared/src/voice-wer.ts", import.meta.url),
			),
			"@elizaos/shared/voice-eot": fileURLToPath(
				new URL("../../packages/shared/src/voice-eot.ts", import.meta.url),
			),
			"@elizaos/shared/transcripts": fileURLToPath(
				new URL("../../packages/shared/src/transcripts.ts", import.meta.url),
			),
			"@elizaos/shared": fileURLToPath(
				new URL("../../packages/shared/src/index.ts", import.meta.url),
			),
		},
	},
	test: {
		globals: true,
		environment: "node",
		// I7/I8/I9 tests live next to their sources under `src/` (voice-budget,
		// device-tier, active-model co-locate `.test.ts` siblings). Keep the
		// `__tests__/**` glob for legacy suites and ALSO pick up co-located
		// `.test.ts` files under `src/` so they actually run via
		// `bun --filter @elizaos/plugin-local-inference verify`.
		include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
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
