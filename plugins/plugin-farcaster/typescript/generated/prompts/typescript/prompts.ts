/**
 * Auto-generated prompt templates
 * DO NOT EDIT - Generated from ../../../../prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const replyCastTemplate = `Based on this request: "{{request}}", generate a helpful and engaging reply for a Farcaster cast (max 320 characters).`;

export const REPLY_CAST_TEMPLATE = replyCastTemplate;

export const sendCastTemplate = `Based on this request: "{{request}}", generate a concise Farcaster cast (max 320 characters). Be engaging and use appropriate hashtags if relevant.`;

export const SEND_CAST_TEMPLATE = sendCastTemplate;
