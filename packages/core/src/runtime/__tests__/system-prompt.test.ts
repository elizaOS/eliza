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
	buildCharacterStyleDirections,
	dropDuplicateLeadingSystemMessage,
	extractLeadingSystemPrompt,
	normalizeSystemPromptRole,
	renderChatMessagesForPrompt,
	renderSystemPromptBio,
	resolveEffectiveSystemPrompt,
	textFromChatMessageContent,
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

describe("buildCharacterStyleDirections", () => {
	it("renders style.all then style.chat once, excluding style.post", () => {
		const block = buildCharacterStyleDirections({
			character: {
				name: "Ada",
				style: {
					all: ["be brief", "{{name}} never uses emoji"],
					chat: ["match their energy"],
					post: ["one idea per post"],
				},
			},
		});

		expect(block).toBe(
			[
				"# Message Directions for Ada",
				"be brief",
				"Ada never uses emoji",
				"match their energy",
			].join("\n"),
		);
		expect(block).not.toContain("one idea per post");
	});

	it("returns empty when the character declares no chat style", () => {
		expect(buildCharacterStyleDirections({ character: { name: "Ada" } })).toBe(
			"",
		);
		expect(
			buildCharacterStyleDirections({
				character: { name: "Ada", style: { all: [], chat: [] } },
			}),
		).toBe("");
		expect(buildCharacterStyleDirections({ character: null })).toBe("");
	});

	describe("renderSystemPromptBio", () => {
		it("trims a plain-string bio", () => {
			expect(renderSystemPromptBio("  Warm and precise.  ")).toBe(
				"Warm and precise.",
			);
		});

		it("joins array entries, trimming strings and dropping empties and non-strings", () => {
			expect(renderSystemPromptBio([" A ", 42, "", null, "B"])).toBe("A B");
		});

		it("returns empty for values that are neither string nor array", () => {
			expect(renderSystemPromptBio(null)).toBe("");
			expect(renderSystemPromptBio(undefined)).toBe("");
			expect(renderSystemPromptBio(42)).toBe("");
			expect(renderSystemPromptBio({ length: 2 })).toBe("");
		});
	});

	describe("normalizeSystemPromptRole", () => {
		it("trims and uppercases string roles", () => {
			expect(normalizeSystemPromptRole("  owner ")).toBe("OWNER");
		});

		it("maps blank and missing roles to undefined", () => {
			expect(normalizeSystemPromptRole("   ")).toBeUndefined();
			expect(normalizeSystemPromptRole("")).toBeUndefined();
			expect(normalizeSystemPromptRole(null)).toBeUndefined();
			expect(normalizeSystemPromptRole(undefined)).toBeUndefined();
		});
	});

	describe("buildCanonicalSystemPrompt input fallbacks", () => {
		it('falls back to "the agent" when the name is blank', () => {
			const prompt = buildCanonicalSystemPrompt({
				character: {
					name: "   ",
					system: "You are {{name}}.",
					bio: ["Ask {{agentName}} anything."],
				},
			});

			expect(prompt).toBe(
				[
					"You are the agent.",
					"# About the agent\nAsk the agent anything.",
				].join("\n\n"),
			);
		});

		it("renders empty output when no character or role is provided", () => {
			expect(buildCanonicalSystemPrompt({})).toBe("");
			expect(buildCanonicalSystemPrompt({ character: null })).toBe("");
		});

		it("omits the role line when the user role is blank", () => {
			expect(
				buildCanonicalSystemPrompt({
					character: { name: "Ada", system: "Be kind." },
					userRole: "   ",
				}),
			).toBe("Be kind.");
		});

		it("renders a bio-only prompt under the About heading", () => {
			expect(
				buildCanonicalSystemPrompt({
					character: { name: "Rex", bio: ["Quick."] },
				}),
			).toBe("# About Rex\nQuick.");
		});
	});

	describe("textFromChatMessageContent", () => {
		it("trims plain-string content", () => {
			expect(textFromChatMessageContent("  Hello there.  ")).toBe(
				"Hello there.",
			);
		});

		it("returns empty for content that is neither string nor array", () => {
			expect(textFromChatMessageContent(undefined)).toBe("");
			expect(textFromChatMessageContent(42)).toBe("");
			expect(textFromChatMessageContent({ text: "nope" })).toBe("");
		});

		it("joins trimmed text parts with newlines, skipping malformed parts", () => {
			expect(
				textFromChatMessageContent([
					{ type: "text", text: " Alpha " },
					null,
					"raw string",
					[],
					{ type: "image" },
					{ text: 42 },
					{ type: "text", text: "Beta" },
				]),
			).toBe("Alpha\nBeta");
		});

		it("returns empty when no array part yields text", () => {
			expect(textFromChatMessageContent([null, 42])).toBe("");
		});
	});

	describe("extractLeadingSystemPrompt", () => {
		it("returns undefined for absent, empty, or system-less message lists", () => {
			expect(extractLeadingSystemPrompt(undefined)).toBeUndefined();
			expect(extractLeadingSystemPrompt([])).toBeUndefined();
			expect(
				extractLeadingSystemPrompt([{ role: "user", content: "Hello." }]),
			).toBeUndefined();
		});

		it("reads the first system message, joining multi-part content", () => {
			expect(
				extractLeadingSystemPrompt([
					{
						role: "system",
						content: [
							{ type: "text", text: "Part one." },
							{ type: "text", text: "Part two." },
						],
					},
				]),
			).toBe("Part one.\nPart two.");
		});

		it("treats a whitespace-only leading system message as absent", () => {
			expect(
				extractLeadingSystemPrompt([{ role: "system", content: "   " }]),
			).toBeUndefined();
		});
	});

	describe("resolveEffectiveSystemPrompt edge branches", () => {
		it("treats non-object params as absent and uses the fallback", () => {
			expect(
				resolveEffectiveSystemPrompt({ params: "nope", fallback: "F." }),
			).toBe("F.");
		});

		it("resolves nothing when no source is present", () => {
			expect(resolveEffectiveSystemPrompt({})).toBeUndefined();
			expect(
				resolveEffectiveSystemPrompt({ params: null, fallback: null }),
			).toBeUndefined();
		});

		// An explicit non-string params.system short-circuits the lookup instead of
		// falling through to messages or fallback.
		it("returns undefined when params.system exists but is not a string", () => {
			expect(
				resolveEffectiveSystemPrompt({
					params: { system: 42, messages: [{ role: "system", content: "M." }] },
					fallback: "F.",
				}),
			).toBeUndefined();
		});

		it("preserves an explicitly present but textless params.system", () => {
			expect(resolveEffectiveSystemPrompt({ params: { system: "   " } })).toBe(
				"",
			);
			expect(
				resolveEffectiveSystemPrompt({ params: { system: null } }),
			).toBeUndefined();
		});

		it("falls through to the fallback when the leading system message carries no text", () => {
			expect(
				resolveEffectiveSystemPrompt({
					params: { messages: [{ role: "system", content: "   " }] },
					fallback: "  F.  ",
				}),
			).toBe("F.");
		});

		it("maps a blank or non-string fallback to undefined", () => {
			expect(resolveEffectiveSystemPrompt({ fallback: "   " })).toBeUndefined();
			expect(resolveEffectiveSystemPrompt({ fallback: 42 })).toBeUndefined();
		});
	});

	describe("dropDuplicateLeadingSystemMessage edge branches", () => {
		it("passes absent and empty message lists straight through", () => {
			expect(
				dropDuplicateLeadingSystemMessage(undefined, "S."),
			).toBeUndefined();
			expect(dropDuplicateLeadingSystemMessage([], "S.")).toEqual([]);
		});

		it("keeps every message when there is no resolved prompt to compare against", () => {
			const messages = [{ role: "system", content: "S." }];
			expect(dropDuplicateLeadingSystemMessage(messages, undefined)).toBe(
				messages,
			);
			expect(dropDuplicateLeadingSystemMessage(messages, "")).toBe(messages);
		});

		it("compares trimmed text so padded duplicates still drop", () => {
			const messages = [
				{ role: "system", content: "  S.  " },
				{ role: "user", content: "Hello." },
			];
			expect(dropDuplicateLeadingSystemMessage(messages, "S.")).toEqual([
				{ role: "user", content: "Hello." },
			]);
		});

		it("matches structured content parts, not just plain strings", () => {
			const messages = [
				{ role: "system", content: [{ type: "text", text: "S." }] },
				{ role: "user", content: "Hello." },
			];
			expect(dropDuplicateLeadingSystemMessage(messages, "S.")).toEqual([
				{ role: "user", content: "Hello." },
			]);
		});
	});

	describe("renderChatMessagesForPrompt", () => {
		it("returns undefined for absent or empty message lists", () => {
			expect(renderChatMessagesForPrompt(undefined)).toBeUndefined();
			expect(renderChatMessagesForPrompt([])).toBeUndefined();
		});

		it("renders role-headed blocks separated by blank lines", () => {
			expect(
				renderChatMessagesForPrompt([
					{ role: "system", content: "S." },
					{ role: "user", content: "U." },
					{ role: "assistant", content: "A." },
				]),
			).toBe("system:\nS.\n\nuser:\nU.\n\nassistant:\nA.");
		});

		it("skips messages whose content renders to no text", () => {
			expect(
				renderChatMessagesForPrompt([
					{ role: "user", content: "   " },
					{ role: "assistant", content: null },
					{ role: "user", content: "Hi." },
				]),
			).toBe("user:\nHi.");
		});

		it("omits only the first system message matching omitDuplicateSystem", () => {
			expect(
				renderChatMessagesForPrompt(
					[
						{ role: "system", content: "S." },
						{ role: "system", content: "S." },
						{ role: "user", content: "U." },
					],
					{ omitDuplicateSystem: " S. " },
				),
			).toBe("system:\nS.\n\nuser:\nU.");
		});

		it("keeps the leading message when the omit value does not match or is blank", () => {
			const messages = [
				{ role: "system", content: "S." },
				{ role: "user", content: "U." },
			];
			expect(
				renderChatMessagesForPrompt(messages, {
					omitDuplicateSystem: "Other.",
				}),
			).toBe("system:\nS.\n\nuser:\nU.");
			expect(
				renderChatMessagesForPrompt(messages, { omitDuplicateSystem: "   " }),
			).toBe("system:\nS.\n\nuser:\nU.");
		});

		it("applies the omit comparison only to a leading system message", () => {
			expect(
				renderChatMessagesForPrompt(
					[
						{ role: "user", content: "S." },
						{ role: "user", content: "U." },
					],
					{ omitDuplicateSystem: "S." },
				),
			).toBe("user:\nS.\n\nuser:\nU.");
		});

		it("returns undefined when every block is skipped", () => {
			expect(
				renderChatMessagesForPrompt([{ role: "system", content: "S." }], {
					omitDuplicateSystem: "S.",
				}),
			).toBeUndefined();
		});
	});
});
