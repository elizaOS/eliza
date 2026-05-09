/**
 * Smoke test for the live-agent-test helper.
 *
 * Primary scenario: with `OPENAI_API_KEY` (or the Cerebras alias) set, ask the
 * agent "What is 2+2?" through the full message pipeline and assert "4".
 *
 * Secondary scenarios: each newly supported provider (`ollama`, `xai`,
 * `nvidiacloud`, `elizacloud`, `cerebras`) registers a describe block whose
 * default required-env keys force a clean skip when the corresponding
 * credentials are absent. We don't try to verify pass-with-key for providers
 * we don't have access to — the goal is "no silent failure, clear yellow
 * warning, suite registered as skipped".
 */
import { expect, it } from "vitest";

import { describeLive } from "../live-agent-test";

await describeLive(
	"live-agent-test smoke (Cerebras)",
	{ requiredEnv: ["OPENAI_API_KEY"] },
	({ harness }) => {
		it(
			"answers a simple math question through the full message pipeline",
			async () => {
				const reply = await harness().runAgentTurn(
					"What is 2+2? Reply briefly.",
				);
				expect(reply.length).toBeGreaterThan(0);
				expect(reply).toContain("4");
			},
			120_000,
		);
	},
);

// Each of the suites below is expected to skip cleanly in CI / local runs
// without provider credentials. They exercise the new provider-id branches
// so a future regression in the helper (e.g. missing config entry, broken
// import path, wrong required-env defaults) trips the smoke instead of
// rotting in the converter agent's inline runtimes.
await describeLive(
	"live-agent-test smoke (ollama)",
	{ provider: "ollama", requiredEnv: [] },
	({ harness }) => {
		it("answers a simple math question via ollama", async () => {
			const reply = await harness().runAgentTurn(
				"What is 2+2? Reply briefly.",
			);
			expect(reply.length).toBeGreaterThan(0);
		}, 120_000);
	},
);

await describeLive(
	"live-agent-test smoke (xai)",
	{ provider: "xai", requiredEnv: [] },
	({ harness }) => {
		it("answers a simple math question via xai", async () => {
			const reply = await harness().runAgentTurn(
				"What is 2+2? Reply briefly.",
			);
			expect(reply.length).toBeGreaterThan(0);
		}, 120_000);
	},
);

await describeLive(
	"live-agent-test smoke (nvidiacloud)",
	{ provider: "nvidiacloud", requiredEnv: [] },
	({ harness }) => {
		it("answers a simple math question via nvidiacloud", async () => {
			const reply = await harness().runAgentTurn(
				"What is 2+2? Reply briefly.",
			);
			expect(reply.length).toBeGreaterThan(0);
		}, 120_000);
	},
);

await describeLive(
	"live-agent-test smoke (elizacloud)",
	{ provider: "elizacloud", requiredEnv: [] },
	({ harness }) => {
		it("answers a simple math question via elizacloud", async () => {
			const reply = await harness().runAgentTurn(
				"What is 2+2? Reply briefly.",
			);
			expect(reply.length).toBeGreaterThan(0);
		}, 120_000);
	},
);

await describeLive(
	"live-agent-test smoke (cerebras alias)",
	{ provider: "cerebras", requiredEnv: [] },
	({ harness }) => {
		it("answers a simple math question via the cerebras alias", async () => {
			const reply = await harness().runAgentTurn(
				"What is 2+2? Reply briefly.",
			);
			expect(reply.length).toBeGreaterThan(0);
			expect(reply).toContain("4");
		}, 120_000);
	},
);
