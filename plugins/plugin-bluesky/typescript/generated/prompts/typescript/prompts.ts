/**
 * Auto-generated prompt templates
 * DO NOT EDIT - Generated from ../../../../prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const generateDmTemplate = `Generate a friendly direct message response under 200 characters.`;

export const GENERATE_DM_TEMPLATE = generateDmTemplate;

export const generatePostTemplate = `Generate an engaging BlueSky post under {{maxLength}} characters.`;

export const GENERATE_POST_TEMPLATE = generatePostTemplate;

export const truncatePostTemplate = `Shorten to under {{maxLength}} characters: "{{text}}"`;

export const TRUNCATE_POST_TEMPLATE = truncatePostTemplate;
