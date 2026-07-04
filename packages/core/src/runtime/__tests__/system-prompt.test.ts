import { describe, expect, it } from "vitest";
import {
	buildCanonicalSystemPrompt,
	dropDuplicateLeadingSystemMessage,
	resolveEffectiveSystemPrompt,
} from "../system-prompt";

describe("system prompt helpers", () => {
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

	it("inserts $-sequence names literally (no String.replace pattern interpretation)", () => {
		// A replacer function must be used so `$$`, `$&`, `$1`, `$\`` in the
		// name are inserted verbatim rather than interpreted as substitution
		// patterns. String-replacement semantics would mangle e.g. "Cash$$" →
		// "Cash$" in the rendered prompt.
		for (const name of ["Cash$$", "M$&M", "A$1P", "x$`y"]) {
			const prompt = buildCanonicalSystemPrompt({
				character: {
					name,
					system: "You are {{name}}.",
					bio: ["{{agentName}} is here."],
				},
			});
			expect(prompt).toContain(`You are ${name}.`);
			expect(prompt).toContain(`${name} is here.`);
			expect(prompt).toContain(`# About ${name}`);
			expect(prompt).not.toContain("{{name}}");
			expect(prompt).not.toContain("{{agentName}}");
		}
	});

	it("does not substitute whitespace-padded tokens (strict {{name}} form only)", () => {
		// Presets emit bare `{{name}}` / `{{agentName}}` with no inner spaces.
		// The strict regex matches shared canonical and leaves padded variants
		// untouched (they never occur in real presets).
		const prompt = buildCanonicalSystemPrompt({
			character: {
				name: "Eliza",
				system: "You are {{ name }} and {{name}}.",
				bio: [],
			},
		});
		expect(prompt).toContain("{{ name }}");
		expect(prompt).toContain("You are {{ name }} and Eliza.");
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
