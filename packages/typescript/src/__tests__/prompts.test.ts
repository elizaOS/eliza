import { describe, expect, it } from "vitest";
import {
	booleanFooter,
	imageDescriptionTemplate,
	messageHandlerTemplate,
	postCreationTemplate,
	shouldRespondTemplate,
} from "../prompts";

describe("Prompts", () => {
	describe("Template Structure", () => {
		it("shouldRespondTemplate should contain required placeholders and response structure", () => {
			expect(shouldRespondTemplate).toContain("{{agentName}}");
			expect(shouldRespondTemplate).toContain("{{providers}}");
			expect(shouldRespondTemplate).toContain("<response>");
			expect(shouldRespondTemplate).toContain("</response>");
			expect(shouldRespondTemplate).toContain("<name>");
			expect(shouldRespondTemplate).toContain("<reasoning>");
			expect(shouldRespondTemplate).toContain("<action>");
			expect(shouldRespondTemplate).toMatch(/RESPOND \| IGNORE \| STOP/);

			expect(shouldRespondTemplate).toContain("rules[6]:");
			expect(shouldRespondTemplate).toContain(
				"direct mention of {{agentName}}",
			);
			expect(shouldRespondTemplate).toContain("decision_note:");
			expect(shouldRespondTemplate).toContain("talking TO {{agentName}}");
		});

		it("messageHandlerTemplate should contain required placeholders and structure", () => {
			expect(messageHandlerTemplate).toContain("{{agentName}}");
			expect(messageHandlerTemplate).toContain("{{providers}}");
			expect(messageHandlerTemplate).toContain("<response>");
			expect(messageHandlerTemplate).toContain("</response>");
			expect(messageHandlerTemplate).toContain("<thought>");
			expect(messageHandlerTemplate).toContain("<actions>");
			expect(messageHandlerTemplate).toContain("<providers>");
			expect(messageHandlerTemplate).toContain("<text>");
			expect(messageHandlerTemplate).toContain("<simple>");

			expect(messageHandlerTemplate).toContain("rules[8]:");
			expect(messageHandlerTemplate).toContain(
				"actions execute in listed order",
			);
			expect(messageHandlerTemplate).toContain("IGNORE or STOP");
			expect(messageHandlerTemplate).toContain("STOP means the task is done");
			expect(messageHandlerTemplate).toContain("fields[5]{name,meaning}:");
			expect(messageHandlerTemplate).toContain("provider_hints");
			expect(messageHandlerTemplate).toContain("formatting:");
			expect(messageHandlerTemplate).toContain("fenced code blocks");
			expect(messageHandlerTemplate).toContain("inline backticks");
		});

		it("postCreationTemplate should contain required placeholders and examples", () => {
			expect(postCreationTemplate).toContain("{{agentName}}");
			expect(postCreationTemplate).toContain("{{xUserName}}");
			expect(postCreationTemplate).toContain("{{providers}}");
			expect(postCreationTemplate).toContain("{{adjective}}");
			expect(postCreationTemplate).toContain("{{topic}}");
			expect(postCreationTemplate).toContain("<response>");
			expect(postCreationTemplate).toContain("</response>");
			expect(postCreationTemplate).toContain("<thought>");
			expect(postCreationTemplate).toContain("<post>");
			expect(postCreationTemplate).toContain("<imagePrompt>");

			// Check for example outputs
			expect(postCreationTemplate).toMatch(/Example task outputs:/);
			expect(postCreationTemplate).toContain("A post about");
		});

		it("booleanFooter should be a simple instruction", () => {
			expect(booleanFooter).toBe("Respond with only a YES or a NO.");
			expect(booleanFooter).toMatch(/^Respond with only a YES or a NO\.$/);
		});

		it("imageDescriptionTemplate should contain proper XML structure", () => {
			expect(imageDescriptionTemplate).toContain("<task>");
			expect(imageDescriptionTemplate).toContain("<instructions>");
			expect(imageDescriptionTemplate).toContain("<output>");
			expect(imageDescriptionTemplate).toContain("<response>");
			expect(imageDescriptionTemplate).toContain("</response>");
			expect(imageDescriptionTemplate).toContain("<title>");
			expect(imageDescriptionTemplate).toContain("<description>");
			expect(imageDescriptionTemplate).toContain("<text>");

			// Check for important instructions
			expect(imageDescriptionTemplate).toContain("Analyze the provided image");
			expect(imageDescriptionTemplate).toContain(
				"Be objective and descriptive",
			);
		});
	});

	describe("Template Consistency", () => {
		const templates = [
			shouldRespondTemplate,
			messageHandlerTemplate,
			postCreationTemplate,
			imageDescriptionTemplate,
		];

		it("all templates should have concise output-only instructions", () => {
			templates.forEach((template) => {
				expect(template).toMatch(/No <think>|Do NOT include any thinking/);
				expect(
					template.includes("Return exactly one <response>") ||
						template.includes(
							"IMPORTANT: Your response must ONLY contain the <response></response> XML block",
						),
				).toBe(true);
			});
		});

		it("all templates should use proper XML closing tags", () => {
			templates.forEach((template) => {
				// Extract only the XML response format sections (not instructions mentioning tags)
				const responseBlocks =
					template.match(/<response>[\s\S]*?<\/response>/g) || [];

				responseBlocks.forEach((block) => {
					// Get all open tags within response blocks
					const openTags = (block.match(/<[^/][^>]+>/g) || [])
						.filter((tag) => !tag.includes("/>"))
						.filter((tag) => !tag.includes("think")); // Exclude mentioned-but-not-present tags

					const closeTags = block.match(/<\/[^>]+>/g) || [];

					// For each unique open tag, there should be a corresponding close tag
					openTags.forEach((openTag) => {
						const tagName = openTag.match(/<([^\s>]+)/)?.[1];
						if (
							tagName &&
							!["br", "hr", "img", "input", "meta", "link"].includes(tagName)
						) {
							expect(
								closeTags.some((closeTag) => closeTag.includes(tagName)),
							).toBe(true);
						}
					});
				});

				// Also check the main structural tags outside response blocks
				const mainTags = [
					"task",
					"providers",
					"instructions",
					"output",
					"keys",
					"actionNames",
				];
				mainTags.forEach((tag) => {
					if (template.includes(`<${tag}>`)) {
						expect(template).toContain(`</${tag}>`);
					}
				});
			});
		});
	});

	describe("Template Placeholders", () => {
		it("should use consistent placeholder format", () => {
			const placeholderPattern = /\{\{[^}]+\}\}/g;

			const shouldRespondPlaceholders =
				shouldRespondTemplate.match(placeholderPattern) || [];
			const messageHandlerPlaceholders =
				messageHandlerTemplate.match(placeholderPattern) || [];
			const postCreationPlaceholders =
				postCreationTemplate.match(placeholderPattern) || [];

			// All placeholders should use double curly braces
			[
				...shouldRespondPlaceholders,
				...messageHandlerPlaceholders,
				...postCreationPlaceholders,
			].forEach((placeholder) => {
				expect(placeholder).toMatch(/^\{\{[^}]+\}\}$/);
			});

			// Common placeholders should be consistent across templates
			expect(shouldRespondPlaceholders).toContain("{{agentName}}");
			expect(messageHandlerPlaceholders).toContain("{{agentName}}");
			expect(postCreationPlaceholders).toContain("{{agentName}}");
		});
	});
});
