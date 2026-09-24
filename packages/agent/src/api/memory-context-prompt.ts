/** Authored templates for api behavior, preserving complete model context. */

export const memoryContextQaTemplate = `Answer only from the provided context. If context is insufficient, say so explicitly.
Return the complete answer supported by the context.

Query: {{query}}

Saved memory notes:
{{memorySection}}

Knowledge snippets:
{{knowledgeSection}}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const MEMORY_CONTEXT_QA_TEMPLATE = memoryContextQaTemplate;
