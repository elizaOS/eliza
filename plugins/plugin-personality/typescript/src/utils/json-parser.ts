/**
 * Utility functions for parsing JSON from LLM responses
 */

/**
 * Helper function to extract JSON from LLM responses that might be wrapped in markdown
 * @param response - The raw LLM response that may contain JSON
 * @returns The parsed JSON object
 * @throws Error if JSON cannot be parsed
 */
export function extractJsonFromResponse(
  response: string,
): Record<string, unknown> {
  // Remove markdown code blocks if present
  let cleaned = response.trim();

  // Check for ```json or ``` markers
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.substring(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.substring(3);
  }

  // Remove trailing ``` if present
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }

  // Trim any remaining whitespace
  cleaned = cleaned.trim();

  // Try to parse the JSON
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // If parsing fails, try to find JSON object in the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw error;
  }
}
