/**
 * LLM prompt templates for the BlueSky plugin: DM reply generation, post
 * generation, and over-limit post truncation. `{{maxLength}}` / `{{text}}`
 * placeholders are substituted at compose time. Each template is exported under
 * both a camelCase and an UPPER_SNAKE_CASE name.
 */

export const generateDmTemplate = `Generate a friendly direct message response under 200 characters.`;

export const GENERATE_DM_TEMPLATE = generateDmTemplate;

export const generatePostTemplate = `Generate an engaging BlueSky post under {{maxLength}} characters.`;

export const GENERATE_POST_TEMPLATE = generatePostTemplate;

export const truncatePostTemplate = `Shorten to under {{maxLength}} characters: "{{text}}"`;

export const TRUNCATE_POST_TEMPLATE = truncatePostTemplate;
