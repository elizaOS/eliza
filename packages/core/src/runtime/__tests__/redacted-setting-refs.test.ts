/**
 * Matrix F16 (tj-b6bf03e81193a2): prompts redact settings values as
 * [REDACTED:<NAME>]; the model copies the placeholder into tool args and
 * UUID validation rejects it — every tool wanting the admin entity id
 * failed with "does not match pattern". The resolver substitutes ONLY
 * entity-id-class placeholders with UUID-shaped setting values, at the
 * executed-args copy (recorded tool calls keep the placeholder).
 */
import { describe, expect, it, vi } from "vitest";
import { resolveRedactedSettingRefs } from "../execute-planned-tool-call";

const ADMIN_ID = "b961de75-2cf0-06bc-9d61-82f32e752c63";

function runtimeWith(settings: Record<string, string>) {
	return {
		getSetting: (key: string) => settings[key],
		logger: { debug: vi.fn() },
	};
}

describe("resolveRedactedSettingRefs (F16)", () => {
	it("resolves the live failure shape: admin entity id placeholder", () => {
		const runtime = runtimeWith({ ELIZA_ADMIN_ENTITY_ID: ADMIN_ID });
		const resolved = resolveRedactedSettingRefs(runtime, {
			entityId: "[REDACTED:ELIZA_ADMIN_ENTITY_ID]",
			query: "favorite color",
		});
		expect(resolved.entityId).toBe(ADMIN_ID);
		expect(resolved.query).toBe("favorite color");
	});

	it("never resolves credential-class placeholders", () => {
		const runtime = runtimeWith({ OPENAI_API_KEY: "sk-secret" });
		const args = { token: "[REDACTED:OPENAI_API_KEY]" };
		expect(resolveRedactedSettingRefs(runtime, args)).toBe(args);
	});

	it("refuses non-UUID setting values and embedded placeholders", () => {
		const runtime = runtimeWith({ WEIRD_ENTITY_ID: "not-a-uuid" });
		const args = {
			a: "[REDACTED:WEIRD_ENTITY_ID]",
			b: "prefix [REDACTED:ELIZA_ADMIN_ENTITY_ID] suffix",
		};
		const resolved = resolveRedactedSettingRefs(runtime, args);
		expect(resolved.a).toBe("[REDACTED:WEIRD_ENTITY_ID]");
		expect(resolved.b).toBe(args.b);
	});
});
