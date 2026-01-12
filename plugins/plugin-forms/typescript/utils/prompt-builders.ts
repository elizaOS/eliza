import { composePrompt } from "@elizaos/core";
import {
  FORM_CREATION_TEMPLATE,
  FORM_EXTRACTION_TEMPLATE,
} from "../generated/prompts/typescript/prompts.js";
import type { PromptFieldInfo } from "../types.js";

export function buildExtractionPrompt(userMessage: string, fields: PromptFieldInfo[]): string {
  const fieldDescriptions = fields
    .map((f) => {
      const criteriaAttr = f.criteria ? ` criteria="${f.criteria}"` : "";
      const desc = f.description || "";
      return `  <field id="${f.id}" type="${f.type}" label="${f.label}"${criteriaAttr}>${desc}</field>`;
    })
    .join("\n");

  const fieldTemplates = fields
    .map((f) => `  <${f.id}>extracted value or omit if not found</${f.id}>`)
    .join("\n");

  return composePrompt({
    state: {
      user_message: userMessage,
      field_descriptions: fieldDescriptions,
      field_templates: fieldTemplates,
    },
    template: FORM_EXTRACTION_TEMPLATE,
  });
}

export function buildCreationPrompt(userMessage: string, availableTypes: string[]): string {
  const typesList = availableTypes.map((t) => `  <type>${t}</type>`).join("\n");

  return composePrompt({
    state: {
      user_message: userMessage,
      available_types: typesList,
    },
    template: FORM_CREATION_TEMPLATE,
  });
}
