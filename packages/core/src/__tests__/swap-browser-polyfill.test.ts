import { expect, test, vi } from "vitest";

// util@0.12.5, used by the browser Vite alias, exposes this throwing stub.
vi.mock("node:util", () => ({
	types: {
		isProxy: () => {
			throw new Error("isProxy is not supported in userland");
		},
	},
}));

import { RegexEntityRecognizer } from "../security/entity-recognizer";
import { PseudonymSession } from "../security/pii-pseudonymizer";
import { isRuntimeAbortSignal } from "../security/runtime-abort-signal";
import { SecretSwapSession } from "../security/secret-swap";

test("unsupported proxy detection never inspects a candidate control object", () => {
	let traps = 0;
	const candidate = new Proxy(
		{},
		{
			getPrototypeOf() {
				traps++;
				throw new Error("prototype trap");
			},
			get() {
				traps++;
				throw new Error("property trap");
			},
			ownKeys() {
				traps++;
				throw new Error("keys trap");
			},
		},
	);
	expect(isRuntimeAbortSignal(candidate)).toBe(false);
	expect(traps).toBe(0);
	expect(isRuntimeAbortSignal(new AbortController().signal)).toBe(false);
});

test("ordinary browser payloads still redact when util cannot detect proxies", async () => {
	const input = {
		text: "Contact person@example.invalid at 1600 Pennsylvania Avenue NW",
	};
	expect(new SecretSwapSession().substituteInValue(input).text).not.toContain(
		"person@example.invalid",
	);
	const pii = new PseudonymSession({ recognizer: new RegexEntityRecognizer() });
	await pii.learn(input.text);
	expect(pii.substituteInValue(input).text).not.toContain(
		"1600 Pennsylvania Avenue NW",
	);
});
