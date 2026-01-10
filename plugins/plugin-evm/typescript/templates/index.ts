/**
 * @elizaos/plugin-evm LLM Templates
 *
 * Prompt templates for extracting action parameters from natural language.
 * These prompts are auto-generated from prompts/*.txt files.
 * DO NOT EDIT - Generated from ../../dist/prompts/typescript/prompts.ts
 *
 * To modify prompts, edit the .txt files in prompts/ and run:
 *   npm run build:prompts
 */

// Import generated prompts
import {
  transferTemplate,
  bridgeTemplate,
  swapTemplate,
  proposeTemplate,
  voteTemplate,
  queueProposalTemplate,
  executeProposalTemplate,
} from "../../dist/prompts/typescript/prompts.js";

// Re-export for backwards compatibility
export {
  transferTemplate,
  bridgeTemplate,
  swapTemplate,
  proposeTemplate,
  voteTemplate,
  queueProposalTemplate,
  executeProposalTemplate,
};
