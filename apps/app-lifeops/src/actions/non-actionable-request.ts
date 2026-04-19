function normalizeRequestText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function looksLikeEmailVenting(text: string): boolean {
  const normalized = normalizeRequestText(text);
  if (!/\b(email|gmail|inbox|mailbox|mail)\b/.test(normalized)) {
    return false;
  }
  return (
    /\bi hate\b/.test(normalized) ||
    /\btime sink\b/.test(normalized) ||
    /\boverwhelm(?:ing|ed)\b/.test(normalized)
  );
}

export function looksLikeCalendarObservation(text: string): boolean {
  const normalized = normalizeRequestText(text);
  return (
    /^my calendar has been\b/.test(normalized) ||
    /\bmy calendar\b.*\b(crazy|chaotic|packed|insane|nuts)\b/.test(normalized)
  );
}

export function looksLikeGoalAdviceOnly(text: string): boolean {
  const normalized = normalizeRequestText(text);
  return (
    /\bgoal/.test(normalized) &&
    /\b(any )?(tips|advice|suggestions?)\b/.test(normalized)
  );
}

export function looksLikeScreenTimeReflection(text: string): boolean {
  const normalized = normalizeRequestText(text);
  return (
    /\bi think i spend\b.*\btoo much time\b.*\b(phone|screen)\b/.test(
      normalized,
    ) || /\bi spend\b.*\btoo much time\b.*\bon my phone\b/.test(normalized)
  );
}

export function looksLikeRelationshipFollowUpRequest(text: string): boolean {
  const normalized = normalizeRequestText(text);
  if (!/\bfollow up with\b/.test(normalized)) {
    return false;
  }

  return (
    /\b(next\s+(week|month)|tomorrow|today|tonight|this\s+week|on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at\s+\d)\b/.test(
      normalized,
    ) && !/\bevery\b/.test(normalized)
  );
}

/**
 * Build-an-app / coding-task requests. Must stay narrow: false negatives
 * (LIFE declines a LifeOps prompt) are worse than false positives (LIFE
 * hands off a coding-ish request). LIFE keeps CREATE_TASK/COMPLETE_TASK as
 * similes for LifeOps todos ("add a task: pick up laundry"); this predicate
 * lets validate() decline when the prompt is clearly code work so the
 * action router falls through to the orchestrator.
 *
 * Accepted edge case: "add a habit to build an app every day" matches and
 * LIFE declines. Priority-checking LIFE words would regress "build a todo
 * app" and "make a habit tracker" which are legitimate coding requests.
 */
export function looksLikeCodingTaskRequest(text: string): boolean {
  const normalized = normalizeRequestText(text);
  // verb + technical-artifact noun (order-sensitive: verb comes first)
  if (
    /\b(build|make|create|write|deploy|ship|add|spin up)\b[^.]*\b(app|page|site|website|dashboard|widget|component|script|tool|api|endpoint|server|bot|cli|plugin|action|route|handler|library|module|repo)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  // Explicit code/PR/debug surfaces, never LifeOps.
  if (
    /\b(pull request|merge conflict|git (push|pull|clone|rebase)|typescript error|debug (the|this|a) (bug|error|code)|fix (the|a|this) bug)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}
