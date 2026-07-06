// Exercises the voice-policy ratchet's AST classifier (#14873) with planted
// reply-literal fixtures — the diff-scoped git machinery is covered by the
// script's own --self-test; this pins the classification contract in vitest.
import { describe, expect, test } from "bun:test";

const ratchet = await import(
	new URL("../voice-policy-ratchet.mjs", import.meta.url).href
);

const REL = "packages/agent/src/fixture.ts";

describe("voice-policy-ratchet collectFindings", () => {
	test("flags a planted hardcoded reply literal", () => {
		const src = `function h(callback) { callback({ text: "you have 3 unread messages" }); }`;
		const findings = ratchet.collectFindings(src, REL);
		expect(findings.length).toBe(1);
	});

	test("flags a raw error interpolated into a reply", () => {
		const src =
			"function h(callback, error) { callback({ text: `something broke: ${error.message}` }); }";
		expect(ratchet.collectFindings(src, REL).length).toBe(1);
	});

	test("does not flag text marked agentVoiced", () => {
		const src = `function h(callback) { callback({ text: "the owner's own words", agentVoiced: true }); }`;
		expect(ratchet.collectFindings(src, REL).length).toBe(0);
	});

	test("does not flag a value routed through the gate (no literal)", () => {
		const src = `async function h(callback, voiced) { callback({ text: voiced.text, agentVoiced: true }); }`;
		expect(ratchet.collectFindings(src, REL).length).toBe(0);
	});

	test("honors the // voice-policy:V escape annotation", () => {
		const src = `function h(callback) {
      // voice-policy:V4 designed literal surface
      callback({ text: "scripted tutorial line" });
    }`;
		expect(ratchet.collectFindings(src, REL).length).toBe(0);
	});

	test("ignores non-reply callees carrying a text literal", () => {
		const src = `function h() { logEvent({ text: "internal telemetry, not a reply" }); }`;
		expect(ratchet.collectFindings(src, REL).length).toBe(0);
	});

	test("flags a bare string passed to a reply callee", () => {
		const src = `function h(ctx) { ctx.reply("please try again in a moment"); }`;
		expect(ratchet.collectFindings(src, REL).length).toBe(1);
	});
});
