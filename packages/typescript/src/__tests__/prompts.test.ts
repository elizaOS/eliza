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
			expect(shouldRespondTemplate).toContain("available_contexts:");
			expect(shouldRespondTemplate).toContain("context_routing:");
			expect(shouldRespondTemplate).toContain("output:");
			expect(shouldRespondTemplate).toContain("name: {{agentName}}");
			expect(shouldRespondTemplate).toContain("reasoning:");
			expect(shouldRespondTemplate).toContain("speak_up:");
			expect(shouldRespondTemplate).toContain("hold_back:");
			expect(shouldRespondTemplate).toContain("action: REPLY");
			expect(shouldRespondTemplate).toContain("primaryContext:");
			expect(shouldRespondTemplate).toContain("secondaryContexts:");
			expect(shouldRespondTemplate).toContain(
				"request to stop or be quiet -> STOP",
			);

			expect(shouldRespondTemplate).toContain("rules[7]:");
			expect(shouldRespondTemplate).toContain(
				"direct mention of {{agentName}}",
			);
			expect(shouldRespondTemplate).toContain("decision_note:");
			expect(shouldRespondTemplate).toContain("talking TO {{agentName}}");
			expect(shouldRespondTemplate).toContain("dual_pressure[2]:");
			expect(shouldRespondTemplate).toContain("anti_gaming:");
			expect(shouldRespondTemplate).toContain("action_space:");
			const actionSpaceIndex = shouldRespondTemplate.indexOf("action_space:");
			const outputIndex = shouldRespondTemplate.indexOf("output:");
			expect(actionSpaceIndex).toBeLessThan(outputIndex);
		});

		it("messageHandlerTemplate should contain required placeholders and structure", () => {
			expect(messageHandlerTemplate).toContain("{{agentName}}");
			expect(messageHandlerTemplate).toContain("{{providers}}");
			expect(messageHandlerTemplate).toContain("thought:");
			expect(messageHandlerTemplate).toContain("actions[1]:");
			expect(messageHandlerTemplate).toContain("providers[0]:");
			expect(messageHandlerTemplate).toContain("text:");
			expect(messageHandlerTemplate).toContain("simple: true");

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
			expect(postCreationTemplate).toContain("thought:");
			expect(postCreationTemplate).toContain("post:");
			expect(postCreationTemplate).toContain("imagePrompt:");

			// Check for example outputs
			expect(postCreationTemplate).toMatch(/Example task outputs:/);
			expect(postCreationTemplate).toContain("A post about");
		});

		it("booleanFooter should be a simple instruction", () => {
			expect(booleanFooter).toBe("Respond with only a YES or a NO.");
			expect(booleanFooter).toMatch(/^Respond with only a YES or a NO\.$/);
		});

		it("imageDescriptionTemplate should contain proper TOON structure", () => {
			expect(imageDescriptionTemplate).toContain("Task:");
			expect(imageDescriptionTemplate).toContain("Instructions:");
			expect(imageDescriptionTemplate).toContain("Output:");
			expect(imageDescriptionTemplate).toContain("title:");
			expect(imageDescriptionTemplate).toContain("description:");
			expect(imageDescriptionTemplate).toContain("text:");

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
				expect(template).toMatch(
					/No <think>|Do NOT include any thinking|Do not include any text, thinking, or reasoning before or after it/,
				);
				expect(template.includes("TOON")).toBe(true);
			});
		});

		it("all templates should avoid legacy XML response wrappers", () => {
			templates.forEach((template) => {
				expect(template).not.toContain("<response>");
				expect(template).not.toContain("</response>");
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
