/**
 * Auto-generated prompt templates
 * DO NOT EDIT - Generated from ../../../prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const replyPostTemplate = `Based on this request: "{{request}}", generate a helpful and engaging reply for a Farcaster public post (cast, max 320 characters).`;

export const REPLY_POST_TEMPLATE = replyPostTemplate;

export const sendPostTemplate = `Based on this request: "{{request}}", generate a concise Farcaster public post (cast, max 320 characters). Be engaging and use appropriate hashtags if relevant.`;

export const SEND_POST_TEMPLATE = sendPostTemplate;
