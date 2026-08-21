/**
 * Tests for the RECENT_ERRORS provider: renders nothing when clean, dedupes by
 * code (newest wins), caps the list, and ages out stale entries. Uses a fake
 * runtime that returns a controlled reported-error ring — except the W5-025
 * case, which drives a real AgentRuntime so the redactSecrets scrub under test
 * is the production one.
 */

import { describe, expect, it } from "vitest";
import type { ReportedError } from "../errors";
import { ElizaError } from "../errors";
import { AgentRuntime } from "../runtime";
import { redactWithSecrets } from "../security/redact";
import type { Character, IAgentRuntime, Memory, State } from "../types";
import {
	MAX_CONTEXT_CHARS,
	QUIET_ERROR_CODES,
	recentErrorsProvider,
	serializeContext,
} from "./recent-errors";

function runtimeWith(entries: ReportedError[]): IAgentRuntime {
	return {
		getRecentReportedErrors: () => entries,
		// The real AgentRuntime scrubs via redactWithSecrets; identity is the
		// right default for tests that don't exercise the scrubbing path.
		redactSecrets: (text: string) => text,
	} as unknown as IAgentRuntime;
}

const message = {} as Memory;
const state = {} as State;

describe("RECENT_ERRORS provider", () => {
	it("renders nothing and costs no tokens when there are no errors", async () => {
		const result = await recentErrorsProvider.get(
			runtimeWith([]),
			message,
			state,
		);
		expect(result.text).toBe("");
		expect(result.values?.recentErrors).toBe("");
		expect(result.data?.recentErrors).toEqual([]);
	});

	it("dedupes by code, keeping the newest occurrence", async () => {
		const now = Date.now();
		const entries: ReportedError[] = [
			{ scope: "A", code: "DUP", message: "old dup", at: now - 1000 },
			{ scope: "A", code: "DUP", message: "new dup", at: now - 100 },
			{ scope: "B", code: "OTHER", message: "other", at: now - 50 },
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		const surfaced = result.data?.recentErrors as ReportedError[];
		expect(surfaced).toHaveLength(2);
		const dup = surfaced.find((e) => e.code === "DUP");
		expect(dup?.message).toBe("new dup");
		expect(result.text).toContain("DUP: new dup");
		expect(result.text).not.toContain("old dup");
	});

	it("caps the surfaced list at 5 distinct codes (newest-first)", async () => {
		const now = Date.now();
		const entries: ReportedError[] = Array.from({ length: 8 }, (_, i) => ({
			scope: "S",
			code: `C${i}`,
			message: `m${i}`,
			at: now - i * 10,
		}));
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		const surfaced = result.data?.recentErrors as ReportedError[];
		expect(surfaced).toHaveLength(5);
		// Newest (C0) first, oldest kept is C4.
		expect(surfaced[0].code).toBe("C0");
		expect(surfaced.at(-1)?.code).toBe("C4");
	});

	it("ages out entries older than 30 minutes", async () => {
		const now = Date.now();
		const entries: ReportedError[] = [
			{ scope: "S", code: "STALE", message: "stale", at: now - 31 * 60 * 1000 },
			{ scope: "S", code: "FRESH", message: "fresh", at: now - 60 * 1000 },
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		const surfaced = result.data?.recentErrors as ReportedError[];
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0].code).toBe("FRESH");
	});

	it("renders empty when every entry is stale", async () => {
		const now = Date.now();
		const entries: ReportedError[] = [
			{ scope: "S", code: "OLD", message: "old", at: now - 60 * 60 * 1000 },
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		expect(result.text).toBe("");
	});

	it("never narrates internal scheduler-plumbing codes into chat (SHADOW-ACCOUNT-DEBUG)", async () => {
		const now = Date.now();
		// The exact codes that spammed Shadow's chat 9x.
		const entries: ReportedError[] = [
			{
				scope: "TaskService.timer",
				code: "TASK_TICK_FAILED",
				message: "1 scheduled task failure(s)",
				at: now - 100,
			},
			{
				scope: "validateTasks",
				code: "TASK_WORKER_MISSING",
				message: "No worker registered for task X",
				at: now - 90,
			},
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		expect(result.text).toBe("");
		expect(result.data?.recentErrors).toEqual([]);
	});

	it("still surfaces a genuinely actionable error even when quiet codes are present", async () => {
		const now = Date.now();
		const entries: ReportedError[] = [
			{
				scope: "TaskService.timer",
				code: "TASK_TICK_FAILED",
				message: "noise",
				at: now - 100,
			},
			{
				scope: "WalletPlugin",
				code: "WALLET_RPC_DOWN",
				message: "upstream RPC unreachable",
				at: now - 50,
			},
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		const surfaced = result.data?.recentErrors as ReportedError[];
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0].code).toBe("WALLET_RPC_DOWN");
		expect(result.text).not.toContain("TASK_TICK_FAILED");
	});

	it("never narrates diagnostic-only persistence failures into chat", async () => {
		const entries: ReportedError[] = [
			{
				scope: "TrajectoryStorage.write",
				code: "TRAJECTORY_SAVE_FAILED",
				message: "Could not save trajectory",
				context: { stepId: "step-failed", diagnosticOnly: true },
				at: Date.now(),
			},
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		expect(result.text).toBe("");
		expect(result.data?.recentErrors).toEqual([]);
	});

	it("frames the block as internal diagnostics that never absorb user questions", async () => {
		// A live "available_apps provider timeout" rendered without this framing
		// got answered as if it were the user's question (tj-f8249b30e986d6).
		const entries: ReportedError[] = [
			{
				scope: "provider:available_apps",
				code: "PROVIDER_TIMEOUT",
				message: "available_apps provider timeout",
				at: Date.now() - 100,
			},
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		expect(result.text).toContain("internal diagnostics");
		expect(result.text).toContain(
			"Never assume a user's message refers to them unless the user explicitly asks about errors.",
		);
		// The self-healing / escalation instruction is unchanged.
		expect(result.text).toContain("tell the owner");
	});

	it("exports the quiet-code set with the scheduler plumbing codes", () => {
		expect(QUIET_ERROR_CODES.has("TASK_TICK_FAILED")).toBe(true);
		expect(QUIET_ERROR_CODES.has("TASK_WORKER_MISSING")).toBe(true);
		expect(QUIET_ERROR_CODES.has("WALLET_RPC_DOWN")).toBe(false);
	});

	it("scrubs credentials from reported errors before they reach the prompt (W1-062)", async () => {
		// A third-party plugin reports an error echoing a credential — in the
		// message (value-shape pattern) and in the serialized context (literal
		// configured secret). Neither may ship to the model provider.
		const entries: ReportedError[] = [
			{
				scope: "ThirdPartyPlugin",
				code: "UPLOAD_FAILED",
				message: "POST https://api.example.com/upload failed",
				context: {
					authorization: "Bearer sk-livekey-notconfigured99",
					password: "hunter2plainpass123",
				},
				at: Date.now(),
			},
		];
		const runtime = {
			getRecentReportedErrors: () => entries,
			// Mirror AgentRuntime.redactSecrets: literal secrets + patterns.
			redactSecrets: (text: string) =>
				redactWithSecrets(text, {
					secrets: { SERVICE_PASSWORD: "hunter2plainpass123" },
				}),
		} as unknown as IAgentRuntime;

		const result = await recentErrorsProvider.get(runtime, message, state);

		expect(result.text).not.toContain("sk-livekey-notconfigured99");
		expect(result.text).not.toContain("hunter2plainpass123");
		// Masked in both slots (the combined redactor re-masks its own marker,
		// so assert the mask shape, not the exact marker format).
		expect(result.text).toContain('"password":"***"');
		expect(result.text).toContain("sk-liv…ed99");
		expect(result.text).toContain("UPLOAD_FAILED");
	});

	it("scrubs credential patterns even when the character configures no secrets (W5-025)", async () => {
		// A default/minimal character has no settings.secrets. The runtime's
		// redactSecrets used to early-return unchanged text in that case, so the
		// pattern library never engaged and reported errors carried API keys and
		// Bearer tokens into the prompt verbatim. This drives the real
		// AgentRuntime + provider path end to end.
		const runtime = new AgentRuntime({
			character: { name: "no-secrets-character" } as Character,
		});
		runtime.reportError(
			"ThirdPartyPlugin",
			new ElizaError(
				"GET https://api.example.com/v1/data?key=AIzaSyD4iE4fZa1234567890abcdef failed with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
				{ code: "FETCH_FAILED" },
			),
		);

		const result = await recentErrorsProvider.get(runtime, message, state);

		expect(result.text).not.toContain("AIzaSyD4iE4fZa1234567890abcdef");
		expect(result.text).not.toContain(
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
		);
		expect(result.text).toContain("FETCH_FAILED");
	});
});

describe("serializeContext well-formed Unicode boundaries", () => {
	function isWellFormed(value: string): boolean {
		for (let index = 0; index < value.length; index += 1) {
			const codeUnit = value.charCodeAt(index);
			if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
				const next = value.charCodeAt(index + 1);
				if (!(next >= 0xdc00 && next <= 0xdfff)) {
					return false;
				}
				index += 1;
			} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
				return false;
			}
		}
		return true;
	}

	it("keeps surrogate pairs intact when serializing and truncating context", () => {
		const prefix = '{"payload":"';
		const budget = MAX_CONTEXT_CHARS - 1; // 399
		// Fill string so emoji lands at 398/399 index
		const needed = budget - prefix.length - 1;
		const payload = `${"a".repeat(needed)}🦊${"b".repeat(50)}`;
		const res = serializeContext({ payload }) ?? "";
		expect(res.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
		expect(isWellFormed(res)).toBe(true);
		expect(res.endsWith("…")).toBe(true);
	});

	it("sanitizes lone surrogates before truncation in context", () => {
		const payload = `bad \uD800 ${"c".repeat(500)}`;
		const res = serializeContext({ payload }) ?? "";
		expect(res).toContain("\uFFFD");
		expect(isWellFormed(res)).toBe(true);
	});

	it("sanitizes lone surrogates without truncation when fitting under limit", () => {
		const payload = "ok \uD800 end";
		const res = serializeContext({ payload }) ?? "";
		expect(res).toBe(JSON.stringify({ payload: "ok \uFFFD end" }));
		expect(isWellFormed(res)).toBe(true);
	});
});
