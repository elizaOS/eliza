/**
 * Smoke test for the live-agent-test helper. Asks the agent "What is 2+2?"
 * through the full message pipeline and asserts the reply contains "4".
 *
 * Skips with a yellow warning when CEREBRAS_API_KEY (or OPENAI_API_KEY) is
 * unavailable.
 */
import { expect, it } from "vitest";

import { describeLive } from "../live-agent-test";

describeLive(
	"live-agent-test smoke (Cerebras)",
	{ requiredEnv: ["OPENAI_API_KEY"] },
	({ harness }) => {
		it(
			"answers a simple math question through the full message pipeline",
			async () => {
				const reply = await harness().runAgentTurn("What is 2+2? Reply briefly.");
				expect(reply.length).toBeGreaterThan(0);
				expect(reply).toContain("4");
			},
			120_000,
		);
	},
);
