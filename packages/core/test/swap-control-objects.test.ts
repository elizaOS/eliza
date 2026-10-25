/**
 * Secret and PII swap walk every model request before it leaves the runtime.
 * Provider params also carry runtime control objects such as the request
 * AbortSignal. Normalizing one into a plain record makes fetch reject it, so
 * enabling either swap must not break cancellation or the request itself.
 *
 * The dispatcher cases drive a real AgentRuntime + SQLiteDatabaseAdapter with a
 * registered model handler that records exactly what a provider would receive.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { RegexEntityRecognizer } from "../src/security/entity-recognizer.ts";
import { PseudonymSession } from "../src/security/pii-pseudonymizer.ts";
import { SecretSwapSession } from "../src/security/secret-swap.ts";
import type { Character } from "../src/types/agent.ts";
import { ModelType } from "../src/types/model.ts";

const EMAIL = "jane.okafor@acmecapital.com";
const CARD = "4111 1111 1111 1111";
const SSN = "123-45-6789";
const ADDRESS = "1600 Pennsylvania Avenue NW";
const PROMPT = `Follow up with ${EMAIL} about card ${CARD}, SSN ${SSN}, at ${ADDRESS}.`;

describe("swap sessions preserve runtime control objects", () => {
	it("keeps the AbortSignal identity through PII substitute and restore", async () => {
		const controller = new AbortController();
		const session = new PseudonymSession({
			recognizer: new RegexEntityRecognizer(),
		});
		await session.learn(PROMPT);
		const swapped = session.substituteInValue({
			prompt: PROMPT,
			signal: controller.signal,
		});
		expect(swapped.signal).toBe(controller.signal);
		expect(swapped.prompt).not.toContain(ADDRESS);
		const restored = session.restoreInValue(swapped);
		expect(restored.signal).toBe(controller.signal);
		expect(restored.prompt).toBe(PROMPT);
	});

	it("keeps the AbortSignal identity through secret substitute and restore", () => {
		const controller = new AbortController();
		const session = new SecretSwapSession({ knownSecrets: {} });
		const swapped = session.substituteInValue({
			prompt: PROMPT,
			signal: controller.signal,
		});
		expect(swapped.signal).toBe(controller.signal);
		for (const value of [EMAIL, CARD, SSN]) {
			expect(swapped.prompt).not.toContain(value);
		}
		const restored = session.restoreInValue(swapped);
		expect(restored.signal).toBe(controller.signal);
		expect(restored.prompt).toBe(PROMPT);
	});

	it("still normalizes ordinary class instances so their text is swapped", () => {
		class Envelope {
			constructor(public body: string) {}
		}
		const session = new SecretSwapSession({ knownSecrets: {} });
		const swapped = session.substituteInValue({
			wrapped: new Envelope(PROMPT),
		});
		expect(JSON.stringify(swapped)).not.toContain(EMAIL);
	});
});

describe("model dispatch with swaps enabled", () => {
	const saved = {
		secret: process.env.ELIZA_SECRET_SWAP_ENABLED,
		pii: process.env.ELIZA_PII_SWAP_ENABLED,
	};
	afterEach(() => {
		for (const [key, value] of [
			["ELIZA_SECRET_SWAP_ENABLED", saved.secret],
			["ELIZA_PII_SWAP_ENABLED", saved.pii],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	async function dispatch(
		settings: Record<string, string>,
		nativeMessages = false,
		prompt = PROMPT,
	) {
		const runtime = createSQLiteTestRuntime({
			character: { name: "SwapDispatch", bio: "test", settings } as Character,
			logLevel: "fatal",
		});
		let received: Record<string, unknown> | undefined;
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async (_runtime, params) => {
				received = params as Record<string, unknown>;
				return "ok";
			},
			"swap-test-provider",
		);
		const controller = new AbortController();
		await runtime.useModel(ModelType.TEXT_LARGE, {
			...(nativeMessages
				? {
						messages: [
							{ role: "system", content: "Fixture system" },
							{ role: "user", content: prompt },
						],
					}
				: { prompt }),
			signal: controller.signal,
		} as never);
		if (!received) throw new Error("model handler was not invoked");
		return { received, signal: controller.signal };
	}

	it("keeps one canonical system prompt when adding guidance to native messages", async () => {
		const { received, signal } = await dispatch(
			{ ELIZA_SECRET_SWAP_ENABLED: "true", ELIZA_PII_SWAP_ENABLED: "true" },
			true,
		);
		expect(received.system).toContain("Fixture system");
		expect(received.system).toContain("copy its entire reference exactly");
		expect(received.messages).toHaveLength(1);
		expect((received.messages as { role: string }[])[0].role).toBe("user");
		expect(JSON.stringify(received.messages)).not.toContain(EMAIL);
		expect(received.signal).toBe(signal);
	});

	it("hands the provider the real AbortSignal and no swapped identifiers", async () => {
		const { received, signal } = await dispatch({
			ELIZA_SECRET_SWAP_ENABLED: "true",
			ELIZA_PII_SWAP_ENABLED: "true",
		});
		expect(received.signal).toBe(signal);
		expect(received.signal).toBeInstanceOf(AbortSignal);
		expect(received.system).toContain("copy its entire reference exactly");
		expect(received.system).toContain(
			"keep all existing approval requirements",
		);
		expect(received.system).not.toContain(EMAIL);
		const wire = String(received.prompt);
		for (const value of [EMAIL, CARD, SSN, ADDRESS]) {
			expect(wire).not.toContain(value);
		}
	});

	it("swaps an IBAN followed by its BIC, currency or another group", async () => {
		const ibans = [
			"ES91 2100 0418 4502 0005 1332",
			"BE68539007547034",
			"AT61 1904 3002 3457 3201",
		];
		const { received } = await dispatch(
			{ ELIZA_SECRET_SWAP_ENABLED: "true" },
			false,
			`Rent to ${ibans[0]} BIC CAIXESBBXXX, deposit to ${ibans[1]} EUR, ` +
				`fees to ${ibans[2]} 2026 Q4.`,
		);
		const wire = String(received.prompt);
		expect(wire).toContain("BIC CAIXESBBXXX");
		for (const iban of ibans) {
			expect(wire).not.toContain(iban);
		}
	});

	it("enables both swaps from the host environment when no setting is present", async () => {
		process.env.ELIZA_SECRET_SWAP_ENABLED = "true";
		process.env.ELIZA_PII_SWAP_ENABLED = "true";
		const { received, signal } = await dispatch({});
		expect(received.signal).toBe(signal);
		const wire = String(received.prompt);
		for (const value of [EMAIL, CARD, SSN, ADDRESS]) {
			expect(wire).not.toContain(value);
		}
	});

	it("lets an explicit runtime setting override the host environment", async () => {
		process.env.ELIZA_SECRET_SWAP_ENABLED = "true";
		process.env.ELIZA_PII_SWAP_ENABLED = "true";
		const { received } = await dispatch({
			ELIZA_SECRET_SWAP_ENABLED: "false",
			ELIZA_PII_SWAP_ENABLED: "false",
		});
		expect(received.prompt).toBe(PROMPT);
		expect(String(received.system)).not.toContain(
			"Contact references beginning __ELIZA_CONTACT_",
		);
	});

	it("leaves the request untouched when both swaps are disabled", async () => {
		const { received, signal } = await dispatch({});
		expect(received.signal).toBe(signal);
		expect(received.prompt).toBe(PROMPT);
		expect(String(received.system)).not.toContain(
			"Contact references beginning __ELIZA_CONTACT_",
		);
	});
});

describe("untrusted control-shaped values stay inside the redaction boundary", () => {
	it("does not exempt a forged AbortSignal prototype from secret swapping", () => {
		const forged = Object.assign(Object.create(AbortSignal.prototype), {
			body: PROMPT,
		});
		const result = new SecretSwapSession({
			knownSecrets: {},
		}).substituteInValue({ payload: forged });
		expect(result.payload).not.toBe(forged);
		expect(JSON.stringify(result)).not.toContain(EMAIL);
	});
	it("does not exempt a forged AbortSignal prototype from PII swapping", async () => {
		const session = new PseudonymSession({
			recognizer: new RegexEntityRecognizer(),
		});
		await session.learn(PROMPT);
		const forged = Object.assign(Object.create(AbortSignal.prototype), {
			body: PROMPT,
		});
		const result = session.substituteInValue({ payload: forged });
		expect(result.payload).not.toBe(forged);
		expect(JSON.stringify(result)).not.toContain(ADDRESS);
	});
	it("does not inspect an untrusted proxy prototype or read its properties", () => {
		let calls = 0;
		const value = new Proxy(
			{ body: PROMPT },
			{
				getPrototypeOf() {
					calls++;
					throw Error("Prototype executed");
				},
				get() {
					calls++;
					throw Error("Getter executed");
				},
			},
		);
		const result = new SecretSwapSession({
			knownSecrets: {},
		}).substituteInValue(value);
		expect(calls).toBe(0);
		expect(JSON.stringify(result)).not.toContain(EMAIL);
	});
	it("does not pass through a genuine signal carrying added serializable text", () => {
		const signal = Object.assign(new AbortController().signal, {
			body: PROMPT,
		});
		const result = new SecretSwapSession({
			knownSecrets: {},
		}).substituteInValue({ signal });
		expect(result.signal).not.toBe(signal);
		expect(JSON.stringify(result)).not.toContain(EMAIL);
	});
});

describe("clean cancellation controls and accessor safety", () => {
	it("preserves cancellation through native controller and combined signals", () => {
		const controller = new AbortController();
		const signals = [controller.signal, AbortSignal.any([controller.signal])];
		const session = new SecretSwapSession({ knownSecrets: {} });
		const result = session.substituteInValue({ signals, prompt: PROMPT });
		expect(result.signals[0]).toBe(signals[0]);
		expect(result.signals[1]).toBe(signals[1]);
		controller.abort();
		expect(result.signals.every((signal) => signal.aborted)).toBe(true);
	});
	it("does not execute an accessor attached to a control-shaped object", () => {
		let calls = 0;
		const value = Object.create(AbortSignal.prototype);
		Object.defineProperty(value, Symbol("private"), {
			get() {
				calls++;
				return true;
			},
		});
		Object.defineProperty(value, "body", { value: PROMPT, enumerable: true });
		const result = new SecretSwapSession({
			knownSecrets: {},
		}).substituteInValue(value);
		expect(calls).toBe(0);
		expect(JSON.stringify(result)).not.toContain(EMAIL);
	});
	it("PII swapping does not execute proxy prototype or property traps", async () => {
		let calls = 0;
		const session = new PseudonymSession({
			recognizer: new RegexEntityRecognizer(),
		});
		await session.learn(PROMPT);
		const value = new Proxy(
			{ body: PROMPT },
			{
				getPrototypeOf() {
					calls++;
					throw Error("Prototype executed");
				},
				get() {
					calls++;
					throw Error("Getter executed");
				},
			},
		);
		const result = session.substituteInValue(value);
		expect(calls).toBe(0);
		expect(JSON.stringify(result)).not.toContain(ADDRESS);
	});
});
