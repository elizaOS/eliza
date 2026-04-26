import { describe, expect, it } from "vitest";
import {
	booleanFooter,
	imageDescriptionTemplate,
	messageHandlerTemplate,
	postCreationTemplate,
	reflectionEvaluatorTemplate,
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
			expect(shouldRespondTemplate).toContain(
				"task: Decide whether {{agentName}} should respond, ignore, or stop.",
			);
			expect(shouldRespondTemplate).toContain("name: {{agentName}}");
			expect(shouldRespondTemplate).toContain("reasoning:");
			expect(shouldRespondTemplate).toContain("action: RESPOND");
			expect(shouldRespondTemplate).toContain("primaryContext:");
			expect(shouldRespondTemplate).toContain("secondaryContexts:");
			expect(shouldRespondTemplate).toContain("evidenceTurnIds:");

			expect(shouldRespondTemplate).toContain("rules[6]:");
			expect(shouldRespondTemplate).toContain(
				"direct mention of {{agentName}}",
			);
			expect(shouldRespondTemplate).toContain(
				"request to stop or be quiet directed at {{agentName}} -> STOP",
			);
			expect(shouldRespondTemplate).toContain("decision_note:");
			expect(shouldRespondTemplate).toContain(
				"talking ABOUT {{agentName}} or continuing a room conversation around them is not enough",
			);
		});

		it("messageHandlerTemplate should contain required placeholders and structure", () => {
			expect(messageHandlerTemplate).toContain("{{agentName}}");
			expect(messageHandlerTemplate).toContain("{{providers}}");
			expect(messageHandlerTemplate).toContain("<response>");
			expect(messageHandlerTemplate).toContain("<thought>");
			expect(messageHandlerTemplate).toContain("<actions>");
			expect(messageHandlerTemplate).toContain("<name>REPLY</name>");
			expect(messageHandlerTemplate).toContain(
				"<text>Your message here</text>",
			);
			expect(messageHandlerTemplate).toContain("<simple>true</simple>");

			expect(messageHandlerTemplate).toMatch(/rules\[\d+\]:/);
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
			expect(messageHandlerTemplate).toContain("XML only.");
			expect(messageHandlerTemplate).toContain(
				"REPLY means a direct chat reply in the current conversation only",
			);
			expect(messageHandlerTemplate).toContain(
				"set simple=true only when the planner's text should be sent directly as the final reply without running REPLY again",
			);
			expect(messageHandlerTemplate).toContain(
				"if actions are REPLY-only and you want the REPLY action to generate the final user-facing message, set simple=false",
			);
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

		it("reflectionEvaluatorTemplate should require canonical TOON output", () => {
			expect(reflectionEvaluatorTemplate).toContain("Output:");
			expect(reflectionEvaluatorTemplate).toContain(
				"TOON only. Return exactly one TOON document.",
			);
			expect(reflectionEvaluatorTemplate).toContain(
				"Do not output JSON, XML, Markdown fences, or commentary.",
			);
			expect(reflectionEvaluatorTemplate).toContain(
				'thought: "a self-reflective thought on the conversation"',
			);
			expect(reflectionEvaluatorTemplate).toContain("task_completed: false");
			expect(reflectionEvaluatorTemplate).toContain(
				'task_completion_reason: "The request is still incomplete because the needed action has not happened yet."',
			);
			expect(reflectionEvaluatorTemplate).toContain("relationships[0]:");
			expect(reflectionEvaluatorTemplate).toContain("tags[0]: dm_interaction");
			expect(reflectionEvaluatorTemplate).toContain(
				"Use exact UUIDs from the entities-in-room list only.",
			);
			expect(reflectionEvaluatorTemplate).toContain(
				"Always include `task_completed` and `task_completion_reason`.",
			);
			expect(reflectionEvaluatorTemplate).toContain(
				"omit all relationships[...] entries",
			);
			// Phase 4 cleanup: reflection.ts no longer extracts facts. The
			// `{{knownFacts}}` block, the "Extract only durable new facts"
			// instruction, and the `facts[...]` indexed output should all be
			// gone. `factExtractorEvaluator` owns extraction now.
			expect(reflectionEvaluatorTemplate).not.toContain("{{knownFacts}}");
			expect(reflectionEvaluatorTemplate).not.toContain("# Known Facts:");
			expect(reflectionEvaluatorTemplate).not.toContain("facts[0]:");
			expect(reflectionEvaluatorTemplate).not.toContain(
				"Extract only durable new facts",
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
				expect(template).toMatch(/TOON|XML only\./);
			});
		});

		it("all templates should avoid legacy XML response wrappers", () => {
			[
				shouldRespondTemplate,
				postCreationTemplate,
				imageDescriptionTemplate,
			].forEach((template) => {
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
