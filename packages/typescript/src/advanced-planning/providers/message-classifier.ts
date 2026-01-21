import type { Provider } from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { composePrompt } from "../../utils.ts";
import { messageClassifierTemplate } from "../prompts.ts";
import type { JsonValue } from "../types.ts";

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
      const lines = responseText.split("\n");
      const fields: Record<string, string> = {};
      for (const line of lines) {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) continue;
        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        if (key) {
          fields[key] = value;
        }
      }

      const parseField = (key: string): string[] => {
        const value = fields[key];
        if (!value) {
          return [];
        }
        return value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      };

      const complexity = fields.COMPLEXITY || "simple";
      const planningType = fields.PLANNING || "direct_action";
      const confidenceStr = fields.CONFIDENCE || "0.5";
      const confidence = Math.min(
        1.0,
        Math.max(0.0, Number.parseFloat(confidenceStr) || 0.5),
      );

      const capabilities = parseField("CAPABILITIES:");
      const stakeholders = parseField("STAKEHOLDERS:");
      const constraints = parseField("CONSTRAINTS:");
      const dependencies = parseField("DEPENDENCIES:");

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
      const textLower = text.toLowerCase();
      let classification = "general";
      let confidence = 0.5;

      if (
        textLower.includes("strategy") ||
        textLower.includes("plan") ||
        textLower.includes("strategic")
      ) {
        classification = "strategic";
        confidence = 0.7;
      } else if (
        textLower.includes("analyze") ||
        textLower.includes("analysis")
      ) {
        classification = "analysis";
        confidence = 0.8;
      } else if (
        textLower.includes("process") ||
        textLower.includes("processing")
      ) {
        classification = "processing";
        confidence = 0.8;
      } else if (textLower.includes("execute") || textLower.includes("final")) {
        classification = "execution";
        confidence = 0.8;
      }

      const data: Record<string, JsonValue> = {
        classification,
        confidence,
        originalText: text,
        complexity: "simple",
        planningRequired: false,
        planningType: "direct_action",
        capabilities: [],
        stakeholders: [],
        constraints: [],
        dependencies: [],
        error: error instanceof Error ? error.message : String(error),
        fallback: true,
      };

      return {
        text: `Message classified as: ${classification} with confidence: ${confidence} (fallback)`,
        data,
      };
    }
  },
};
