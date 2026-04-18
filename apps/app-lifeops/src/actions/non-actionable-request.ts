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
