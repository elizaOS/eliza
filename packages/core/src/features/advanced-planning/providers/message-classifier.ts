import { messageClassifierTemplate } from "../../../prompts.ts";
import type { Provider } from "../../../types/index.ts";
import { ModelType } from "../../../types/index.ts";
import { composePrompt, parseToonKeyValue } from "../../../utils.ts";
import type { JsonValue } from "../types.ts";

function stringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.flatMap((entry) => stringList(entry))
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	if (typeof value !== "string") {
		return [];
	}
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function legacyClassifierFields(responseText: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of responseText.split("\n")) {
		const separatorIndex = line.indexOf(":");
		if (separatorIndex === -1) continue;
		const key = line.slice(0, separatorIndex).trim().toLowerCase();
		const value = line.slice(separatorIndex + 1).trim();
		if (key) {
			fields[key] = value;
		}
	}
	return fields;
}

export const messageClassifierProvider: Provider = {
	name: "messageClassifier",
	description: "Classifies messages by complexity and planning requirements",

	get: async (runtime, message, _state) => {
		const text = message.content.text || "";

		if (!text.trim()) {
			const data: Record<string, JsonValue> = {
				classification: "general",
				confidence: 0.1,
				complexity: "simple",
				planningRequired: false,
				stakeholders: [],
				constraints: [],
			};
			return {
				text: "Message classified as: general (empty message)",
				data,
			};
		}

		try {
			const classificationPrompt = composePrompt({
				state: {
					text,
				},
				template: messageClassifierTemplate,
			});

			const response = await runtime.useModel(ModelType.TEXT_SMALL, {
				prompt: classificationPrompt,
				temperature: 0.3,
				maxTokens: 300,
			});

			const responseText = String(response);
			const parsed = parseToonKeyValue<Record<string, unknown>>(responseText);
			const fields = parsed ?? legacyClassifierFields(responseText);

			const complexity =
				typeof fields.complexity === "string"
					? fields.complexity
					: typeof fields.COMPLEXITY === "string"
						? fields.COMPLEXITY
						: "simple";
			const planningType =
				typeof fields.planning === "string"
					? fields.planning
					: typeof fields.PLANNING === "string"
						? fields.PLANNING
						: "direct_action";
			const confidenceStr =
				typeof fields.confidence === "string" ||
				typeof fields.confidence === "number"
					? fields.confidence
					: typeof fields.CONFIDENCE === "string" ||
							typeof fields.CONFIDENCE === "number"
						? fields.CONFIDENCE
						: "0.5";
			const confidence = Math.min(
				1.0,
				Math.max(0.0, Number.parseFloat(String(confidenceStr)) || 0.5),
			);

			const capabilities = stringList(
				fields.capabilities ?? fields.CAPABILITIES,
			);
			const stakeholders = stringList(
				fields.stakeholders ?? fields.STAKEHOLDERS,
			);
			const constraints = stringList(fields.constraints ?? fields.CONSTRAINTS);
			const dependencies = stringList(
				fields.dependencies ?? fields.DEPENDENCIES,
			);

			const planningRequired =
				planningType !== "direct_action" && complexity !== "simple";

			const textLower = text.toLowerCase();
			let messageClassification = "general";
			if (
				textLower.includes("strategic") ||
				planningType === "strategic_planning"
			) {
				messageClassification = "strategic";
			} else if (textLower.includes("analyz")) {
				messageClassification = "analysis";
			} else if (textLower.includes("process")) {
				messageClassification = "processing";
			} else if (textLower.includes("execute")) {
				messageClassification = "execution";
			}

			const data: Record<string, JsonValue> = {
				classification: messageClassification,
				confidence,
				originalText: text,
				complexity,
				planningType,
				planningRequired,
				capabilities,
				stakeholders,
				constraints,
				dependencies,
				analyzedAt: Date.now(),
				modelUsed: "TEXT_SMALL",
			};

			return {
				text: `Message classified as: ${messageClassification} (${complexity} complexity, ${planningType}) with confidence: ${confidence}`,
				data,
			};
		} catch (error) {
			throw new Error(
				`Failed to classify message: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	},
};
