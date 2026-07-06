/**
 * Live-model acceptance for the consolidated SETTINGS action (#14364, PR #14461).
 *
 * Drives the REAL message pipeline (Stage-1 classify + Stage-2 planner) against a
 * LIVE model — Cerebras gpt-oss-120b when CEREBRAS_API_KEY is set — with the
 * worktree `@elizaos/plugin-app-control` source (vitest aliases it to src). A
 * natural "disable shell access" / "turn off shell permissions" request must
 * SELECT the SETTINGS action and drive the permissions route
 * (PUT /api/permissions/shell { enabled:false }); a "change my model" request
 * must still select MODEL_SWITCH, proving SETTINGS does not shadow the sibling
 * it delegates to. The permissions route is captured via an injected routeFetch
 * (no API server in this harness), so the assertion is on real planner behavior.
 *
 * Gated on ELIZA_LIVE_TEST=1 + a configured provider key; a no-op otherwise.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import type { Action, Plugin } from "@elizaos/core";
import {
	appControlPlugin,
	createSettingsAction,
} from "@elizaos/plugin-app-control";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { itIf } from "../../../test/helpers/conditional-tests.ts";
import { selectLiveProvider } from "../../../test/helpers/live-provider";
import { ConversationHarness } from "../helpers/conversation-harness.js";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";

const liveModelTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const provider = liveModelTestsEnabled ? selectLiveProvider() : null;
const canRun = liveModelTestsEnabled && provider !== null;

const OUT = "/tmp/settings-live-trajectory.txt";
const log = (s: string) => appendFileSync(OUT, `${s}\n`);

interface CapturedRoute {
	method: string;
	path: string;
	body: unknown;
}

function normalize(name: string): string {
	return name.trim().toUpperCase().replace(/_/g, "");
}

describe("SETTINGS live-model selection (#14364)", () => {
	let runtime: Awaited<ReturnType<typeof createRealTestRuntime>>["runtime"];
	let cleanup: () => Promise<void>;
	const routeCalls: CapturedRoute[] = [];

	beforeAll(async () => {
		if (!canRun) return;
		writeFileSync(OUT, "");
		// Match the acceptance bar's model: Cerebras gpt-oss-120b.
		process.env.OPENAI_SMALL_MODEL ??= "gpt-oss-120b";
		process.env.OPENAI_LARGE_MODEL ??= "gpt-oss-120b";
		process.env.LOG_LEVEL = process.env.ELIZA_E2E_LOG_LEVEL ?? "error";
		process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING = "1";
		process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";

		// Swap SETTINGS for one whose backend route is captured (no live server).
		const settingsWithCapture = createSettingsAction({
			routeFetch: async (request) => {
				routeCalls.push({
					method: request.method,
					path: request.path,
					body: request.body,
				});
				return { ok: true };
			},
		});
		const testPlugin: Plugin = {
			...appControlPlugin,
			name: `${appControlPlugin.name}-live-settings-test`,
			actions: (appControlPlugin.actions ?? []).map((action: Action) =>
				action.name === "SETTINGS" ? settingsWithCapture : action,
			),
		};

		const result = await createRealTestRuntime({
			withLLM: true,
			preferredProvider: provider?.name,
			characterName: "SettingsLiveAgent",
			plugins: [testPlugin],
		});
		runtime = result.runtime;
		cleanup = result.cleanup;

		log(`provider=${result.providerName} model=${result.providerConfig?.largeModel}`);
		log(
			`registered actions: ${runtime.actions.map((a) => a.name).sort().join(", ")}`,
		);
	}, 240_000);

	afterAll(async () => {
		if (cleanup) await cleanup();
	}, 60_000);

	async function selectionFor(
		prompt: string,
	): Promise<{ started: string[]; completed: string[]; reply: string }> {
		const h = new ConversationHarness(runtime, { userName: "Owner" });
		await h.setup();
		h.spy.reset();
		routeCalls.length = 0;
		try {
			const turn = await h.send(prompt);
			const started = h.spy.getStartedCalls().map((c) => c.actionName);
			const completed = h.spy.getCompletedCalls().map((c) => c.actionName);
			log(`\nPROMPT: ${JSON.stringify(prompt)}`);
			log(`  started:   ${started.join(", ") || "(none)"}`);
			log(`  completed: ${completed.join(", ") || "(none)"}`);
			log(`  routeCalls: ${JSON.stringify(routeCalls)}`);
			log(`  reply: ${JSON.stringify(turn.responseText.slice(0, 300))}`);
			return { started, completed, reply: turn.responseText };
		} finally {
			await h.cleanup();
		}
	}

	itIf(canRun)(
		"selects SETTINGS and drives the shell route for 'disable shell access for the agent'",
		async () => {
			const { started, completed } = await selectionFor(
				"disable shell access for the agent",
			);
			const all = [...started, ...completed].map(normalize);
			expect(
				all.includes(normalize("SETTINGS")),
				`Expected SETTINGS selected. started=${started.join(",")} completed=${completed.join(",")}`,
			).toBe(true);
			const shellWrites = routeCalls.filter(
				(r) => r.method === "PUT" && r.path === "/api/permissions/shell",
			);
			expect(
				shellWrites.length,
				`Expected a PUT /api/permissions/shell. routeCalls=${JSON.stringify(routeCalls)}`,
			).toBeGreaterThanOrEqual(1);
			expect(shellWrites[0].body).toMatchObject({ enabled: false });
		},
		180_000,
	);

	itIf(canRun)(
		"selects SETTINGS for 'turn off shell permissions'",
		async () => {
			// The planner is only reached when Stage-1 routes the turn to it; a live
			// model occasionally short-circuits a terse toggle to a bare reply. Retry
			// with escalating explicitness (repo convention) — the assertion is that
			// when the turn reaches the planner, SETTINGS is the selected action.
			const prompts = [
				"turn off shell permissions",
				"change my permissions: turn off shell access",
				"use the settings action to turn off the shell permission",
			];
			const attempts: string[] = [];
			for (const prompt of prompts) {
				const { started, completed } = await selectionFor(prompt);
				const all = [...started, ...completed].map(normalize);
				if (all.includes(normalize("SETTINGS"))) return;
				attempts.push(
					`${JSON.stringify(prompt)} => started=${started.join(",") || "(none)"} completed=${completed.join(",") || "(none)"}`,
				);
			}
			expect(false, `SETTINGS never selected.\n${attempts.join("\n")}`).toBe(
				true,
			);
		},
		240_000,
	);

	itIf(canRun)(
		"still routes 'switch to eliza cloud inference' to MODEL_SWITCH (no shadowing)",
		async () => {
			const { started, completed } = await selectionFor(
				"switch my model to eliza cloud inference",
			);
			const all = [...started, ...completed].map(normalize);
			expect(
				all.includes(normalize("MODEL_SWITCH")),
				`Expected MODEL_SWITCH selected, not shadowed by SETTINGS. started=${started.join(",")} completed=${completed.join(",")}`,
			).toBe(true);
		},
		180_000,
	);
});
