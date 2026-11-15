/**
 * PII swap must hand actions the user's real values back. These cases use the
 * real RegexEntityRecognizer and, for dispatch, a real AgentRuntime with a
 * registered handler that records exactly what a provider would receive.
 */

import { validatePhoneDial } from "@elizaos/contracts/phone-dial";
import { validateSmsSend } from "@elizaos/contracts/sms-send";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { executePlannedToolCall } from "../src/runtime/execute-planned-tool-call.ts";
import { resolveTrajectoryGate } from "../src/runtime/trajectory-gate.ts";
import {
	GazetteerEntityRecognizer,
	RegexEntityRecognizer,
} from "../src/security/entity-recognizer.ts";
import { PseudonymSession } from "../src/security/pii-pseudonymizer.ts";
import { SecretSwapSession } from "../src/security/secret-swap.ts";
import { runWithStreamingContext } from "../src/streaming-context.ts";
import {
	runWithTrajectoryContext,
	type TrajectoryContext,
} from "../src/trajectory-context.ts";
import type { Character } from "../src/types/agent.ts";
import type { Action } from "../src/types/components.ts";
import type { Memory } from "../src/types/memory.ts";
import { ModelType } from "../src/types/model.ts";

const ADDRESS = "12 Main Street";
const PROMPT = `Navigate to ${ADDRESS} after lunch.`;

function newSession() {
	return new PseudonymSession({ recognizer: new RegexEntityRecognizer() });
}

describe("private action execution reverses nested privacy layers", () => {
	// Reserved fictional target and credential; no broker, carrier or external model is installed.
	const phone = "+12025550123";
	const credential = "synthetic-private-action-credential";

	async function fixture(
		kind: string,
		unknownContact = false,
		preserveReferences = false,
	) {
		const secret = new SecretSwapSession({
			knownSecrets: { FIXTURE_KEY: credential },
		});
		const contact = secret.substituteText(phone);
		const learnedContact = unknownContact
			? contact.replace(/_[0-9]+__$/, "_999999__")
			: contact;
		const email = "synthetic@example.invalid";
		const emailReference = secret.substituteText(email);
		const absentReference = secret.substituteText("absent@example.invalid");
		const nerInputs: string[] = [];
		const recognizer = new GazetteerEntityRecognizer([
			{ kind, value: learnedContact },
			{ kind, value: `${learnedContact} Alice Example` },
			{ kind, value: emailReference },
			{ kind, value: `${emailReference} Baker Example` },
			{ kind: "person", value: "Alice Example" },
			{ kind: "person", value: "Baker Example" },
		]);
		const pii = new PseudonymSession({
			salt: "nested-action-regression",
			recognizer: {
				name: recognizer.name,
				recognize: async (text) => {
					nerInputs.push(text);
					return recognizer.recognize(text);
				},
			},
		});
		if (!preserveReferences) await pii.learn(learnedContact);
		const alias = pii.substituteText(learnedContact);
		const runtime = createSQLiteTestRuntime({
			character: {
				name: "PrivateActionFixture",
				bio: "local fixture",
				settings: {
					ELIZA_SECRET_SWAP_ENABLED: "true",
					ELIZA_PII_SWAP_ENABLED: "true",
				},
			} as Character,
			logLevel: "fatal",
		});
		const modelInputs: string[] = [],
			diagnostics: unknown[] = [];
		const privateInputs: Array<{ target: string; credential: unknown }> = [];
		let handlerCalls = 0;
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async (_runtime, params) => {
				modelInputs.push(JSON.stringify(params));
				if (preserveReferences) {
					expect(String(params.prompt)).toContain(learnedContact);
					expect(String(params.prompt)).toContain(emailReference);
					expect(String(params.prompt)).not.toContain("Alice Example");
					expect(String(params.prompt)).not.toContain("Baker Example");
					if (!unknownContact)
						expect(String(params.system)).toContain(`${contact}: phone`);
					expect(String(params.system)).toContain(`${emailReference}: email`);
					expect(String(params.system)).not.toContain(absentReference);
				} else {
					expect(String(params.prompt)).toContain(alias);
					expect(String(params.prompt)).not.toContain(learnedContact);
				}
				return "synthetic local completion";
			},
			"closed-local-provider",
		);
		if (preserveReferences)
			runtime.registerPipelineHook({
				id: "add-protected-contact-and-name",
				phase: "pre_model",
				handler: (_runtime, hookCtx) => {
					if (hookCtx.phase === "pre_model") {
						const params = hookCtx.params as { prompt: string };
						params.prompt += ` ${emailReference} Baker Example`;
					}
				},
			});
		const action: Action = {
			name: "PRIVATE_ACTION_RESTORE_FIXTURE",
			description: "Closed native contract boundary",
			contexts: ["general"],
			parameters: [
				{
					name: "operation",
					required: true,
					schema: { type: "object", additionalProperties: true },
				},
				{ name: "credential", required: true, schema: { type: "string" } },
			],
			validate: async () => true,
			handler: async (_runtime, _message, _state, options) => {
				handlerCalls++;
				const raw = options?.parameters?.operation as { type: string };
				const operation =
					raw.type === "sms_send"
						? validateSmsSend(raw)
						: validatePhoneDial(raw);
				const target =
					operation.type === "sms_send"
						? operation.recipients[0]
						: operation.target.kind === "number"
							? operation.target.number
							: "";
				privateInputs.push({
					target,
					credential: options?.parameters?.credential,
				});
				// Exercise credential projection without returning contact PII as public result data.
				return {
					success: true,
					text: "Validated local fixture",
					data: { credential: options?.parameters?.credential },
				};
			},
			examples: [],
		};
		runtime.registerAction(action);
		const message: Memory = {
			id: crypto.randomUUID(),
			entityId: runtime.agentId,
			roomId: crypto.randomUUID(),
			content: { text: "Synthetic local request" },
		};
		const context: TrajectoryContext = {
			secretSwapSession: secret,
			piiSwapSession: pii,
		};
		return {
			runtime,
			context,
			phone,
			contact,
			learnedContact,
			alias,
			pii,
			nerInputs,
			modelInputs,
			diagnostics,
			privateInputs,
			get handlerCalls() {
				return handlerCalls;
			},
			async execute(type: "sms_send" | "phone_dial") {
				const operation =
					type === "sms_send"
						? {
								type,
								recipients: [alias],
								body: "Synthetic body",
								subscriptionId: 0,
							}
						: { type, target: { kind: "number", number: alias } };
				const params = {
					operation,
					credential: secret.substituteText(credential),
				};
				const original = structuredClone(params);
				const result = await runWithTrajectoryContext(context, () =>
					runWithStreamingContext(
						{
							onToolResult: (event) => {
								diagnostics.push(structuredClone(event));
							},
						},
						async () => {
							await runtime.useModel(ModelType.TEXT_LARGE, {
								prompt: unknownContact
									? learnedContact
									: `${phone}${preserveReferences ? " Alice Example" : ""} ${credential}`,
							});
							return executePlannedToolCall(
								runtime,
								{
									message,
									userRoles: ["OWNER"],
									activeContexts: ["general"],
									entityAliases: {},
								},
								{ name: action.name, params },
								{ actions: [action] },
							);
						},
					),
				);
				expect(params).toEqual(original);
				const publicOutput = JSON.stringify({
					modelInputs,
					diagnostics,
					original,
				});
				expect(publicOutput).not.toContain(phone);
				expect(publicOutput).not.toContain(credential);
				expect(publicOutput).toContain(alias);
				return result;
			},
		};
	}

	it.each([
		["person", "sms_send"],
		["org", "sms_send"],
		["person", "phone_dial"],
		["org", "phone_dial"],
	] as const)(
		"privately restores %s-nested contact data before %s validation",
		async (kind, type) => {
			const f = await fixture(kind);
			try {
				expect(f.pii.entries.some((entry) => entry.value === f.contact)).toBe(
					true,
				);
				const result = await f.execute(type);
				expect(result.success).toBe(true);
				expect(f.handlerCalls).toBe(1);
				expect(f.privateInputs).toEqual([{ target: phone, credential }]);
				expect(f.diagnostics).toHaveLength(1);
			} finally {
				await f.runtime.stop();
			}
		},
	);

	it.each(["person", "org"])(
		"rejects an unknown inner reference expanded from %s before the handler",
		async (kind) => {
			const f = await fixture(kind, true);
			try {
				const result = await f.execute("sms_send");
				expect(result.success).toBe(false);
				expect(f.handlerCalls).toBe(0);
				expect(f.privateInputs).toEqual([]);
			} finally {
				await f.runtime.stop();
			}
		},
	);
	it.each([
		["person", "sms_send"],
		["org", "phone_dial"],
	] as const)(
		"preserves %s-recognized protocol spans through both local NER passes and executes %s",
		async (kind, type) => {
			const f = await fixture(kind, false, true);
			try {
				const result = await f.execute(type);
				expect(result.success).toBe(true);
				expect(f.privateInputs).toEqual([{ target: phone, credential }]);
				expect(f.nerInputs.length).toBeGreaterThanOrEqual(2);
				for (const text of f.nerInputs) {
					expect(text).not.toContain("__ELIZA_CONTACT_");
					expect(text).not.toContain("__ELIZA_SECRET_");
				}
				expect(
					f.pii.entries.some(({ value }) => value === "Alice Example"),
				).toBe(true);
				expect(
					f.pii.entries.some(({ value }) => value === "Baker Example"),
				).toBe(true);
			} finally {
				await f.runtime.stop();
			}
		},
	);
	it("preserves an unknown current reference for strict rejection before execution", async () => {
		const f = await fixture("person", true, true);
		try {
			const result = await f.execute("sms_send");
			expect(result.success).toBe(false);
			expect(f.handlerCalls).toBe(0);
		} finally {
			await f.runtime.stop();
		}
	});

	it("masks only own protocol spans from local recognition with unchanged offsets", () => {
		const own = new SecretSwapSession({ knownSecrets: { TOKEN: credential } });
		const contact = own.substituteText(phone);
		const token = own.substituteText(credential);
		const foreign = new SecretSwapSession().substituteText(phone);
		const input = `Alice${contact}Baker ${token} ${foreign}`;
		const masked = own.maskReferencesForPiiRecognition(input);
		expect(masked).toHaveLength(input.length);
		expect(masked).toBe(
			`Alice${" ".repeat(contact.length)}Baker ${" ".repeat(token.length)} ${foreign}`,
		);
		expect(own.restoreInValue(contact, { failOnUnresolved: true })).toBe(phone);
	});
	it("grounds SMS and dial with both privacy layers under hard trajectory logging opt-out", async () => {
		const previous = process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;
		process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING = "1";
		try {
			expect(resolveTrajectoryGate()).toEqual({
				enabled: false,
				reason: "disable-flag",
			});
			for (const type of ["sms_send", "phone_dial"] as const) {
				const f = await fixture("person", false, true);
				try {
					expect(f.runtime.getService("trajectories")).toBeNull();
					expect((await f.execute(type)).success).toBe(true);
					expect(f.privateInputs).toEqual([{ target: phone, credential }]);
					expect(f.context.trajectoryId).toBeUndefined();
					expect(f.context.trajectoryStepId).toBeUndefined();
					expect(f.context.secretSwapSession).toBeDefined();
					expect(f.context.piiSwapSession).toBeDefined();
				} finally {
					await f.runtime.stop();
				}
			}
		} finally {
			if (previous === undefined)
				delete process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;
			else process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING = previous;
		}
	});
});

describe("PseudonymSession restore", () => {
	it("restores the real address across two learn passes", async () => {
		const session = newSession();
		await session.learn(PROMPT);
		const swapped = session.substituteText(PROMPT);
		expect(swapped).not.toContain(ADDRESS);
		await session.learn(swapped);
		expect(session.size).toBe(1);
		const again = session.substituteText(swapped);
		expect(again).toBe(swapped);
		expect(session.restoreText(again)).toBe(PROMPT);
	});

	it("skips a surrogate followed only by punctuation", async () => {
		const session = newSession();
		await session.learn(PROMPT);
		const surrogate = session.entries[0].surrogate;
		await session.learn(`Is it ${surrogate}.`);
		expect(session.size).toBe(1);
		expect(session.restoreText(session.substituteText(PROMPT))).toBe(PROMPT);
	});

	it("still masks real text around an echoed surrogate", async () => {
		const session = newSession();
		await session.learn(PROMPT);
		const surrogate = session.entries[0].surrogate;
		const echoed = `Ship to ${surrogate} Apt 4`;
		await session.learn(echoed);
		const swapped = session.substituteText(echoed);
		expect(swapped).not.toContain("Apt 4");
		expect(session.restoreText(swapped)).toBe(`Ship to ${ADDRESS} Apt 4`);
	});

	it("restores a surrogate echoed twice to the real address", async () => {
		const session = newSession();
		await session.learn(PROMPT);
		const first = session.substituteText(`Ship to ${ADDRESS} Apt 4`);
		await session.learn(first);
		const second = `Leave at ${session.substituteText(first).slice(8)} Unit 9`;
		await session.learn(second);
		const swapped = session.substituteText(second);
		expect(swapped).not.toContain("Unit 9");
		expect(session.restoreText(swapped)).toBe(
			`Leave at ${ADDRESS} Apt 4 Unit 9`,
		);
	});
});

describe("model dispatch with PII swap", () => {
	const saved = process.env.ELIZA_PII_SWAP_ENABLED;
	afterEach(() => {
		if (saved === undefined) delete process.env.ELIZA_PII_SWAP_ENABLED;
		else process.env.ELIZA_PII_SWAP_ENABLED = saved;
	});

	function makeRuntime() {
		const runtime = createSQLiteTestRuntime({
			character: {
				name: "PiiRestore",
				bio: "test",
				settings: { ELIZA_PII_SWAP_ENABLED: "true" },
			} as Character,
			logLevel: "fatal",
		});
		const received: Record<string, unknown>[] = [];
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async (_runtime, params) => {
				received.push(params as Record<string, unknown>);
				return "ok";
			},
			"pii-restore-provider",
		);
		return { runtime, received };
	}

	it("restores the real address after one model call", async () => {
		const { runtime, received } = makeRuntime();
		const ctx: TrajectoryContext = {};
		await runWithTrajectoryContext(ctx, () =>
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: PROMPT }),
		);
		const wire = String(received[0].prompt);
		expect(wire).not.toContain(ADDRESS);
		expect(ctx.piiSwapSession?.restoreText(wire)).toBe(PROMPT);
	});

	it("masks an address a pre_model hook adds and restores both", async () => {
		const { runtime, received } = makeRuntime();
		const added = " Then stop at 88 Oak Avenue.";
		runtime.registerPipelineHook({
			id: "add-address",
			phase: "pre_model",
			handler: (_runtime, hookCtx) => {
				if (hookCtx.phase !== "pre_model") return;
				const params = hookCtx.params as { prompt: string };
				params.prompt += added;
			},
		});
		const ctx: TrajectoryContext = {};
		await runWithTrajectoryContext(ctx, () =>
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: PROMPT }),
		);
		const wire = String(received[0].prompt);
		expect(wire).not.toContain(ADDRESS);
		expect(wire).not.toContain("88 Oak Avenue");
		expect(ctx.piiSwapSession?.restoreText(wire)).toBe(`${PROMPT}${added}`);
	});

	it("restores the real address when a second call echoes the first surrogate", async () => {
		const { runtime, received } = makeRuntime();
		const ctx: TrajectoryContext = {};
		await runWithTrajectoryContext(ctx, async () => {
			await runtime.useModel(ModelType.TEXT_LARGE, { prompt: PROMPT });
			await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: `Earlier reply: ${String(received[0].prompt)}`,
			});
		});
		const session = ctx.piiSwapSession;
		expect(session?.restoreText(String(received[0].prompt))).toBe(PROMPT);
		expect(session?.restoreText(String(received[1].prompt))).toBe(
			`Earlier reply: ${PROMPT}`,
		);
	});
});

describe("model dispatch secret swap for IMAGE", () => {
	it("swaps a secret in the prompt and leaves input image fields intact", async () => {
		const secret = "fixture-credential-7731-zeta";
		const runtime = createSQLiteTestRuntime({
			character: {
				name: "ImageSwap",
				bio: "test",
				settings: { ELIZA_SECRET_SWAP_ENABLED: "true" },
				secrets: { FIXTURE_TOKEN: secret },
			} as Character,
			logLevel: "fatal",
		});
		let received: Record<string, unknown> | undefined;
		runtime.registerModel(
			ModelType.IMAGE,
			async (_runtime, params) => {
				received = params as Record<string, unknown>;
				return [];
			},
			"image-swap-provider",
		);
		const inputImage = `data:image/png;base64,${Buffer.from(secret).toString("base64")}#${secret}`;
		const bytes = new Uint8Array([1, 2, 3, 4]);
		await runWithTrajectoryContext({}, () =>
			runtime.useModel(ModelType.IMAGE, {
				prompt: `Draw a badge with ${secret} on it`,
				inputImage,
				imageUrl: `https://example.com/${secret}.png`,
				bytes,
			} as never),
		);
		if (!received) throw new Error("image handler was not invoked");
		expect(String(received.prompt)).not.toContain(secret);
		expect(received.inputImage).toBe(inputImage);
		expect(received.imageUrl).toBe(`https://example.com/${secret}.png`);
		expect(received.bytes).toBe(bytes);
		expect([...(received.bytes as Uint8Array)]).toEqual([1, 2, 3, 4]);
	});
});

describe("ELIZA_BRAIN_PROVIDER pin", () => {
	it("names the stale pinned provider instead of a generic handler error", async () => {
		const runtime = createSQLiteTestRuntime({
			character: {
				name: "PinnedBrain",
				bio: "test",
				settings: { ELIZA_BRAIN_PROVIDER: "removed-provider" },
			} as Character,
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async () => "must not fall back",
			"present-provider",
		);
		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" }),
		).rejects.toMatchObject({
			code: "MODEL_PROVIDER_PIN_UNAVAILABLE",
			message: expect.stringContaining("removed-provider"),
		});
	});
});
