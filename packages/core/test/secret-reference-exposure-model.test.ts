/**
 * Replays quint/SecretReferenceExposure.qnt through a real AgentRuntime with
 * ELIZA_SECRET_SWAP_ENABLED. Each model call goes through useModel and its
 * secret swap; each action call goes through executePlannedToolCall, the
 * execution boundary that restores secret references in action arguments.
 */
import { readFileSync } from "node:fs";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import { executePlannedToolCall } from "../src/runtime/execute-planned-tool-call.ts";
import {
	runWithTrajectoryContext,
	type TrajectoryContext,
} from "../src/trajectory-context.ts";
import type { Character } from "../src/types/agent.ts";
import type { Action } from "../src/types/components.ts";
import type { Memory } from "../src/types/memory.ts";
import { ModelType } from "../src/types/model.ts";

// Values 0 and 1 are character secrets the turn's session numbers when it is
// created; 2 is a reserved fictional phone number the user types; 3 is an
// index the session never numbers.
const CREDENTIALS = ["wx-alpha-4417-ab9c2e7f", "wx-beta-9e21-0d4ac3b8"];
const PHONE = "+12025550123";
const VALUES = [...CREDENTIALS, PHONE];
const UNNUMBERED_INDEX = 9999;
const SENTENCES = [
	`Use the forecast key ${CREDENTIALS[0]} for today.`,
	`The backup forecast key is ${CREDENTIALS[1]}.`,
	`Text ${PHONE} that I'm late.`,
];
const CHARACTER: Character = {
	name: "SecretReferenceExposure",
	bio: ["local runtime"],
	settings: { ELIZA_SECRET_SWAP_ENABLED: "true" },
	secrets: {
		FORECAST_API_KEY: CREDENTIALS[0],
		FORECAST_BACKUP_KEY: CREDENTIALS[1],
	},
};
const REFERENCE = /__ELIZA_(?:SECRET|CONTACT)_([0-9a-f]{16})_(\d+)__/;

/** A model step: a prompt that shows new values, or one executed action call. */
type ModelStep =
	| { kind: "prompt"; values: number[] }
	| { kind: "execute"; ref: number; restored: boolean };
interface ModelCase {
	steps: ModelStep[];
}

const DEFAULT_CASES: ModelCase[] = [
	{
		steps: [
			{ kind: "prompt", values: [2] },
			{ kind: "execute", ref: 0, restored: false },
		],
	},
	{
		steps: [
			{ kind: "prompt", values: [1, 2] },
			{ kind: "execute", ref: 1, restored: true },
		],
	},
	{
		steps: [
			{ kind: "prompt", values: [2] },
			{ kind: "execute", ref: 2, restored: true },
			{ kind: "execute", ref: 1, restored: false },
			{ kind: "prompt", values: [1] },
			{ kind: "execute", ref: 1, restored: true },
		],
	},
	{
		steps: [
			{ kind: "prompt", values: [0] },
			{ kind: "execute", ref: 3, restored: false },
			{ kind: "execute", ref: 2, restored: false },
		],
	},
];
const casesFile = process.env.ELIZA_SECRET_REFERENCE_EXPOSURE_MODEL_CASES;
const cases: ModelCase[] = casesFile
	? JSON.parse(readFileSync(casesFile, "utf8"))
	: DEFAULT_CASES;

/** Conformance groups by the reference of the first action call. */
const GROUPS = [
	"first call names credential 0",
	"first call names credential 1",
	"first call names the phone",
	"first call names an unnumbered index",
] as const;
function group(item: ModelCase): number {
	const first = item.steps.find((step) => step.kind === "execute");
	return first?.kind === "execute" ? first.ref : -1;
}

describe("secret reference exposure model", () => {
	it.each(GROUPS.map((name, index) => [name, index] as const))(
		"replays %s",
		async (_name, index) => {
			const own = cases.filter((item) => group(item) === index);
			expect(own.length).toBeGreaterThan(0);
			const runtime = createSQLiteTestRuntime({
				character: CHARACTER,
				logLevel: "fatal",
			});
			const prompts: string[] = [];
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async (_runtime, params) => {
					const { prompt, system } = params as {
						prompt?: string;
						system?: string;
					};
					prompts.push(`${prompt ?? ""}\n${system ?? ""}`);
					return "ok";
				},
				"closed-local-provider",
			);
			const received: string[] = [];
			const action: Action = {
				name: "FETCH_FORECAST",
				description: "Fetch a forecast from a URL",
				contexts: ["general"],
				parameters: [
					{
						name: "url",
						description: "Forecast URL",
						required: true,
						schema: { type: "string" },
					},
				],
				validate: async () => true,
				handler: async (_runtime, _message, _state, options) => {
					const { url } = (options?.parameters ?? {}) as { url?: string };
					received.push(String(url));
					return { success: true, text: "fetched" };
				},
				examples: [],
			};
			runtime.registerAction(action);
			const message: Memory = {
				id: crypto.randomUUID(),
				entityId: runtime.agentId,
				roomId: crypto.randomUUID(),
				content: { text: "What is the forecast?" },
			};
			try {
				for (const item of own) {
					// A new turn: a new trajectory context and a new secret swap session.
					const context: TrajectoryContext = {};
					const shown = new Set<number>();
					let nonce: string | undefined;
					await runWithTrajectoryContext(context, async () => {
						for (const step of item.steps) {
							if (step.kind === "prompt") {
								const before = prompts.length;
								await runtime.useModel(ModelType.TEXT_LARGE, {
									prompt: step.values
										.map((value) => SENTENCES[value])
										.join(" "),
								});
								const seen = prompts.slice(before).join("\n");
								for (const value of step.values) shown.add(value);
								for (const value of VALUES)
									expect(seen.includes(value)).toBe(false);
								const entries = context.secretSwapSession?.entries ?? [];
								for (const value of step.values) {
									const entry = entries.find((e) => e.value === VALUES[value]);
									expect(entry && seen.includes(entry.placeholder)).toBe(true);
								}
								// The model learns the nonce from any reference it sees.
								nonce ??= REFERENCE.exec(seen)?.[1];
								expect(nonce).toBeDefined();
								continue;
							}
							const entries = context.secretSwapSession?.entries ?? [];
							const known = entries.find(
								(entry) => entry.value === VALUES[step.ref],
							)?.placeholder;
							// The model writes the reference for this value whether or not
							// the turn showed it; an unknown value gets a free index.
							const reference =
								known ??
								(step.ref === 2
									? `__ELIZA_CONTACT_${nonce}_${entries.length + 1}__`
									: `__ELIZA_SECRET_${nonce}_${UNNUMBERED_INDEX}__`);
							const calls = received.length;
							const result = await executePlannedToolCall(
								runtime,
								{
									message,
									userRoles: ["OWNER"],
									activeContexts: ["general"],
									entityAliases: {},
								},
								{
									name: action.name,
									params: { url: `https://forecast.invalid/?k=${reference}` },
								},
								{ actions: [action] },
							);
							const handled = received.length > calls;
							const url = handled ? received[received.length - 1] : "";
							const restored =
								step.ref < VALUES.length && url.includes(VALUES[step.ref]);
							expect({
								ref: step.ref,
								success: result.success,
								handled,
								restored,
							}).toEqual({
								ref: step.ref,
								success: step.restored,
								handled: step.restored,
								restored: step.restored,
							});
						}
					});
					// A handler never receives a credential the turn did not show.
					for (const [value, credential] of CREDENTIALS.entries())
						if (!shown.has(value))
							expect(received.some((url) => url.includes(credential))).toBe(
								false,
							);
					received.length = 0;
				}
			} finally {
				await runtime.stop();
			}
		},
	);
});
