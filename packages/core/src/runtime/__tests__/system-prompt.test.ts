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
