/** Authored templates for runtime behavior, preserving complete model context. */

export const observationExtractionTemplate = `You are analyzing recent conversation exchanges between a user and an AI assistant.
Extract any durable observations about the user that would be useful across future sessions.

Categories to look for:
- Preferences (tools, languages, workflows, communication style)
- Facts (role, location, projects they work on, tech stack)
- Standing instructions (things they always/never want)
- Patterns (recurring topics, how they like to work)

Return a JSON array containing every complete durable observation.
If nothing meaningful is found, return an empty array [].
Do NOT include observations about the conversation itself, only about the user.

Recent exchanges:
{{exchanges}}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const OBSERVATION_EXTRACTION_TEMPLATE = observationExtractionTemplate;
