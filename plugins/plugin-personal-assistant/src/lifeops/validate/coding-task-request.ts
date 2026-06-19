/**
 * Validate-time predicates for non-actionable / cross-domain requests.
 *
 * These are i18n + greedy: they pull keyword sets from the shared
 * @elizaos/shared/validation-keywords loader so matching works across all
 * supported locales, and they err on the side of matching more (declining
 * the action and letting routing fall through to a better fit).
 */

import {
  findKeywordTermMatch,
  getValidationKeywordTerms,
} from "@elizaos/shared";

/**
 * Build-an-app / coding-task requests. Owner task/routine creation shares verbs
 * ("make", "create", "add") with code-work prompts; this predicate lets
 * validate() decline so the orchestrator's CREATE_TASK can take the route.
 * Greedy by design — a borderline match (e.g. "add a habit to build an app
 * every day") drops the owner-operation route rather than risk a coding prompt
 * landing in LifeOps.
 */
export function looksLikeCodingTaskRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const terms = getValidationKeywordTerms("validate.codingTaskRequest", {
    includeAllLocales: true,
  });
  return findKeywordTermMatch(trimmed, terms) !== undefined;
}
