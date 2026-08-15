/**
 * Unit coverage for the canonical system-prompt builder and helpers
 * (`buildCanonicalSystemPrompt`, `resolveEffectiveSystemPrompt`,
 * `dropDuplicateLeadingSystemMessage`): character/bio/role rendering,
 * `{{name}}`/`{{agentName}}` substitution, and source precedence. Pure,
 * deterministic.
 */
import { describe, expect, it } from "vitest";
import {
	buildCanonicalSystemPrompt,
	dropDuplicateLeadingSystemMessage,
	renderInlineCharacterKnowledge,
	resolveEffectiveSystemPrompt,
} from "../system-prompt";

describe("system prompt helpers", () => {
	it("puts inline character knowledge in the prompt, after bio", () => {
		const prompt = buildCanonicalSystemPrompt({
			character: {
				name: "Ada",
				system: "Policy.",
				bio: ["Fast."],
				knowledge: [
					"Shaw founded elizaOS.",
					"Cloud apps can set inference markup.",
				],
			},
		});
		expect(prompt).toContain(
			"# What Ada knows\nShaw founded elizaOS.\nCloud apps can set inference markup.",
		);
		expect(prompt.indexOf("# About Ada")).toBeLessThan(
			prompt.indexOf("# What Ada knows"),
		);
	});

	it("keeps document sources out of the prompt: paths, directories, typed items", () => {
		const rendered = renderInlineCharacterKnowledge([
			"A real fact.",
			"/abs/manual.pdf",
			"./rel/notes.md",
			"../up/doc.txt",
			"~/home/doc.txt",
			"file:///x.txt",
			"C:\\win\\doc.txt",
			{ item: { case: "path", value: "/a/b.md" } },
			{ path: "/c/d.md" },
			{ directory: "/e/dir" },
			42,
			"",
			"   ",
		]);
		expect(rendered).toBe("A real fact.");
	});

	it("expands name tokens inside knowledge and omits the section when empty", () => {
		const withTokens = buildCanonicalSystemPrompt({
			character: {
				name: "Ada",
				system: "s",
				bio: [],
				knowledge: ["{{name}} runs on elizaOS."],
			},
		});
		expect(withTokens).toContain("Ada runs on elizaOS.");
		const empty = buildCanonicalSystemPrompt({
			character: { name: "Ada", system: "s", bio: [], knowledge: [] },
		});
		expect(empty).not.toContain("What Ada knows");
	});

	it("bounds knowledge to the character budget instead of flooding the prompt", () => {
		const facts = Array.from({ length: 100 }, (_, i) => `Fact ${i} ${"x".repeat(80)}.`);
		const rendered = renderInlineCharacterKnowledge(facts);
		expect(rendered.length).toBeLessThanOrEqual(1500 + facts.length);
		expect(rendered).toContain("Fact 0");
		expect(rendered).not.toContain("Fact 99");
	});

	it("renders character system, bio, then user role", () => {
		const prompt = buildCanonicalSystemPrompt({
			character: {
				name: "Ada",
				system: "Follow the operator policy.",
				bio: ["Fast.", "Precise."],
			},
			userRole: "admin",
		});

		expect(prompt).toBe(
			[
				"Follow the operator policy.",
				"# About Ada\nFast. Precise.",
				"user_role: ADMIN",
			].join("\n\n"),
		);
	});

	it("substitutes {{name}} / {{agentName}} placeholders in system + bio", () => {
		// Character presets (packages/shared/dist/character-presets.characters.js)
		// persist `{{name}}` tokens so character renames propagate. The runtime
		// must resolve them before the prompt reaches `useModel(...)`.
		const prompt = buildCanonicalSystemPrompt({
			character: {
				name: "Eliza",
				system: "You are {{name}}. Keep it brief.",
				bio: [
					"{{name}} is warm and precise.",
					"{{agentName}} keeps things calm.",
				],
			},
		});

		expect(prompt).toContain("You are Eliza. Keep it brief.");
		expect(prompt).toContain("Eliza is warm and precise.");
		expect(prompt).toContain("Eliza keeps things calm.");
		expect(prompt).not.toContain("{{name}}");
		expect(prompt).not.toContain("{{agentName}}");
	});

	it("inserts names containing $-sequences literally (no String.replace pattern expansion)", () => {
		// A raw-string replacement would read `$$`/`$&` in the name as
		// substitution patterns and mangle it; the replacer must be verbatim.
		const prompt = buildCanonicalSystemPrompt({
			character: {
				name: "Cash$$ M$&M",
				system: "You are {{name}}.",
				bio: ["Ask {{agentName}} anything."],
			},
		});

		expect(prompt).toContain("You are Cash$$ M$&M.");
		expect(prompt).toContain("Ask Cash$$ M$&M anything.");
		expect(prompt).not.toContain("{{name}}");
		expect(prompt).not.toContain("{{agentName}}");
	});

	it("substitution is idempotent (no placeholders → unchanged)", () => {
		const prompt = buildCanonicalSystemPrompt({
			character: {
				name: "Eliza",
				system: "You are Eliza. Keep it brief.",
				bio: ["Eliza is warm and precise."],
			},
		});

		expect(prompt).toBe(
			[
				"You are Eliza. Keep it brief.",
				"# About Eliza\nEliza is warm and precise.",
			].join("\n\n"),
		);
	});

	it("prefers explicit system, then leading message system, then fallback", () => {
		expect(
			resolveEffectiveSystemPrompt({
				params: {
					system: "Explicit.",
					messages: [{ role: "system", content: "Message." }],
				},
				fallback: "Fallback.",
			}),
		).toBe("Explicit.");

		expect(
			resolveEffectiveSystemPrompt({
				params: {
					messages: [{ role: "system", content: "Message." }],
				},
				fallback: "Fallback.",
			}),
		).toBe("Message.");

		expect(
			resolveEffectiveSystemPrompt({ params: {}, fallback: "Fallback." }),
		).toBe("Fallback.");
	});

	it("substitutes {{name}} and {{agentName}} placeholders in system + bio", () => {
		const prompt = buildCanonicalSystemPrompt({
			character: {
				name: "Eliza",
				system: "You are {{name}}. Warm, calm, and precise.",
				bio: [
					"{{name}} is warm, precise, and easy to talk to.",
					"{{agentName}} values accuracy over speed.",
				],
			},
		});

		expect(prompt).not.toMatch(/\{\{\s*name\s*\}\}/);
		expect(prompt).not.toMatch(/\{\{\s*agentName\s*\}\}/);
		expect(prompt).toContain("You are Eliza.");
		expect(prompt).toContain("Eliza is warm, precise");
		expect(prompt).toContain("Eliza values accuracy");
	});

	it("leaves already-resolved system + bio unchanged (idempotent)", () => {
		const prompt = buildCanonicalSystemPrompt({
			character: {
				name: "Eliza",
				system: "You are Eliza.",
				bio: ["Eliza is warm."],
			},
		});
		expect(prompt).toBe("You are Eliza.\n\n# About Eliza\nEliza is warm.");
	});

	it("drops only the duplicate leading system message", () => {
		const messages = [
			{ role: "system", content: "System." },
			{ role: "user", content: "Hello." },
		];

		expect(dropDuplicateLeadingSystemMessage(messages, "System.")).toEqual([
			{ role: "user", content: "Hello." },
		]);
		expect(dropDuplicateLeadingSystemMessage(messages, "Other.")).toEqual(
			messages,
		);
	});
});
