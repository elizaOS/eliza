/**
 * Prompt building utilities for the Forms plugin.
 * Uses the generated prompts and shared types from @elizaos/core.
 */

import type { PromptFieldInfo } from "@elizaos/core";
import { composePrompt } from "@elizaos/core";
import {
  FORM_CREATION_TEMPLATE,
  FORM_EXTRACTION_TEMPLATE,
} from "../generated/prompts/typescript/prompts.js";

/**
 * Build the form extraction prompt with the given user message and fields.
 *
 * @param userMessage - The user's message to extract values from
 * @param fields - List of field information objects
 * @returns The formatted prompt string
 */
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

/**
 * Build the form creation prompt with available form types.
 *
 * @param userMessage - The user's message requesting form creation
 * @param availableTypes - List of available form type names
 * @returns The formatted prompt string
 */
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
