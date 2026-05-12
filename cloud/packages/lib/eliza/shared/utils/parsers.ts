/**
 * Parser Utilities
 *
 * Types and functions for parsing LLM responses.
 */

/**
 * Parsed plan from planning phase.
 */
export interface ParsedPlan {
  canRespondNow?: string;
  thought?: string;
  text?: string;
  providers?: string | string[];
  actions?: string | string[];
}

/**
 * Parsed response from LLM.
 */
export interface ParsedResponse {
  thought?: string;
  text?: string;
}

/**
 * Parses planned items (providers or actions) from XML response.
 * Handles both array and comma-separated string formats.
 *
 * @param items - Items to parse (string, array, or undefined).
 * @returns Array of parsed item strings.
 */
export function parsePlannedItems(items: string | string[] | undefined): string[] {
  if (!items) return [];

  const itemArray = Array.isArray(items) ? items : items.split(",").map((item) => item.trim());

  return itemArray.filter((item) => item && item !== "");
}

/**
 * Checks if plan indicates immediate response capability.
 *
 * @param plan - Parsed plan or null.
 * @returns True if plan indicates immediate response.
 */
export function canRespondImmediately(plan: ParsedPlan | null): boolean {
  return plan?.canRespondNow?.toUpperCase() === "YES" || plan?.canRespondNow === "true";
}
