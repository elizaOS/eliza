const ACTION_UMBRELLA_DELEGATES = new Map<string, ReadonlySet<string>>([
  [
    "TRIAGE_MESSAGES",
    new Set([
      "INBOX",
      "GMAIL_ACTION",
      "OWNER_INBOX",
      "INBOX_TRIAGE_GMAIL",
      "SEND_EMAIL",
      "SEND_MESSAGE",
      "LIST_INBOX",
      "DRAFT_REPLY",
      "DRAFT_FOLLOWUP",
      "SEND_DRAFT",
      "SEARCH_MESSAGES",
      "MANAGE_MESSAGE",
      "RESPOND_TO_MESSAGE",
      "SCHEDULE_DRAFT_SEND",
    ]),
  ],
  [
    "OWNER_CALENDAR",
    new Set([
      "CALENDAR_ACTION",
      "PROPOSE_MEETING_TIMES",
      "CHECK_AVAILABILITY",
      "UPDATE_MEETING_PREFERENCES",
      "CALENDLY",
      "SCHEDULING",
      "SCHEDULE_EVENT",
      "MODIFY_EVENT",
      "CANCEL_EVENT",
    ]),
  ],
  [
    "SEND_DRAFT",
    new Set([
      "OWNER_SEND_MESSAGE",
      "CROSS_CHANNEL_SEND",
      "SEND_MESSAGE",
      "RESPOND_TO_MESSAGE",
    ]),
  ],
  [
    "OWNER_VOICE_CALL",
    new Set(["CALL_USER", "CALL_EXTERNAL", "TWILIO_VOICE_CALL", "MAKE_CALL"]),
  ],
  [
    "OWNER_WEBSITE_BLOCK",
    new Set([
      "BLOCK_WEBSITES",
      "UNBLOCK_WEBSITES",
      "GET_WEBSITE_BLOCK_STATUS",
      "REQUEST_WEBSITE_BLOCKING_PERMISSION",
    ]),
  ],
  [
    "OWNER_APP_BLOCK",
    new Set(["BLOCK_APPS", "UNBLOCK_APPS", "GET_APP_BLOCK_STATUS"]),
  ],
  [
    "OWNER_SCREEN_TIME",
    new Set([
      "SCREEN_TIME",
      "GET_ACTIVITY_REPORT",
      "GET_TIME_ON_APP",
      "GET_TIME_ON_SITE",
      "FETCH_BROWSER_ACTIVITY",
    ]),
  ],
  [
    "OWNER_REMOTE_DESKTOP",
    new Set([
      "REMOTE_DESKTOP",
      "START_REMOTE_SESSION",
      "LIST_REMOTE_SESSIONS",
      "REVOKE_REMOTE_SESSION",
    ]),
  ],
  [
    "OWNER_AUTOFILL",
    new Set([
      "REQUEST_FIELD_FILL",
      "ADD_AUTOFILL_WHITELIST",
      "LIST_AUTOFILL_WHITELIST",
    ]),
  ],
  ["OWNER_CHECKIN", new Set(["RUN_MORNING_CHECKIN", "RUN_NIGHT_CHECKIN"])],
  ["OWNER_RESOLVE_REQUEST", new Set(["APPROVE_REQUEST", "REJECT_REQUEST"])],
  ["OWNER_DEVICE_INTENT", new Set(["PUBLISH_DEVICE_INTENT", "INTENT_SYNC"])],
  ["OWNER_LIFE", new Set(["LIFE"])],
  ["OWNER_HEALTH", new Set(["HEALTH"])],
  ["OWNER_PAYMENTS", new Set(["PAYMENTS"])],
  ["OWNER_SUBSCRIPTIONS", new Set(["SUBSCRIPTIONS"])],
  ["OWNER_PASSWORD_MANAGER", new Set(["PASSWORD_MANAGER"])],
  ["OWNER_DOSSIER", new Set(["DOSSIER", "GENERATE_DOSSIER"])],
  ["OWNER_X", new Set(["X_READ"])],
  ["OWNER_BOOK_TRAVEL", new Set(["BOOK_TRAVEL"])],
  ["OWNER_PROFILE", new Set(["UPDATE_OWNER_PROFILE"])],
  ["OWNER_CONNECTOR", new Set(["LIFEOPS_CONNECTOR"])],
  ["OWNER_COMPUTER_USE", new Set(["LIFEOPS_COMPUTER_USE"])],
  ["OWNER_TOGGLE_FEATURE", new Set(["TOGGLE_LIFEOPS_FEATURE"])],
  ["OWNER_CHAT_THREAD", new Set(["CHAT_THREAD_CONTROL"])],
  [
    "OWNER_RELATIONSHIP",
    new Set([
      "RELATIONSHIP",
      "RELATIONSHIPS",
      "ADD_CONTACT",
      "UPDATE_CONTACT",
      "SEARCH_CONTACTS",
      "LIST_OVERDUE_FOLLOWUPS",
      "MARK_FOLLOWUP_DONE",
      "SET_FOLLOWUP_THRESHOLD",
      "DAYS_SINCE",
    ]),
  ],
]);

export function normalizeScenarioActionName(
  actionName: string | null | undefined,
): string | null {
  const normalized = String(actionName ?? "")
    .trim()
    .toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function isUmbrellaDelegatePair(left: string, right: string): boolean {
  const leftDelegates = ACTION_UMBRELLA_DELEGATES.get(left);
  if (leftDelegates?.has(right)) {
    return true;
  }
  const rightDelegates = ACTION_UMBRELLA_DELEGATES.get(right);
  return rightDelegates?.has(left) ?? false;
}

function shareUmbrellaDelegateFamily(left: string, right: string): boolean {
  for (const delegates of ACTION_UMBRELLA_DELEGATES.values()) {
    if (delegates.has(left) && delegates.has(right)) {
      return true;
    }
  }
  return false;
}

export function actionsAreScenarioEquivalent(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeScenarioActionName(left);
  const normalizedRight = normalizeScenarioActionName(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  return (
    isUmbrellaDelegatePair(normalizedLeft, normalizedRight) ||
    shareUmbrellaDelegateFamily(normalizedLeft, normalizedRight)
  );
}

export function actionMatchesScenarioExpectation(
  candidate: string | null | undefined,
  accepted: readonly string[],
): boolean {
  return accepted.some((expected) =>
    actionsAreScenarioEquivalent(candidate, expected),
  );
}
