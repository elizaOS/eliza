/**
 * Exercises `AgentRuntime.redactSecrets` over configured character secrets:
 * the closed set of non-credential configuration keys (TIMEZONE, LOCALE, …)
 * parked under `settings.secrets` is not redacted literally, while every
 * other configured secret keeps its literal redaction. Deterministic: real
 * runtime, no adapter, no model calls.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Character } from "../types";

const API_KEY = "sk-live-abcdef1234567890abcdef";

function runtimeWithSecrets(secrets: Record<string, string>): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "redaction-test",
			bio: [],
			settings: { secrets },
		} as Character,
		logLevel: "fatal",
	});
}

describe("AgentRuntime.redactSecrets over configured secrets", () => {
	it("keeps timezone and locale configuration readable while redacting credentials", () => {
		const runtime = runtimeWithSecrets({
			TIMEZONE: "America/Los_Angeles",
			LOCALE: "en-US",
			OPENAI_API_KEY: API_KEY,
		});
		const out = runtime.redactSecrets(
			`Zone America/Los_Angeles locale en-US key ${API_KEY}`,
		);
		expect(out).toContain("America/Los_Angeles");
		expect(out).toContain("en-US");
		expect(out).not.toContain("[REDACTED:TIMEZONE]");
		expect(out).not.toContain(API_KEY);
	});

	it("still redacts any other configured secret literally, credential-shaped or not", () => {
		const runtime = runtimeWithSecrets({
			ELIZA_OWNER_CONTACTS_JSON: '{"discord":"owner-handle-42"}',
			DB_PASSWORD: "plain-words-only",
		});
		const out = runtime.redactSecrets(
			'contacts {"discord":"owner-handle-42"} password plain-words-only',
		);
		expect(out).not.toContain("owner-handle-42");
		expect(out).not.toContain("plain-words-only");
	});
});
