const ACTION_UMBRELLA_DELEGATES = new Map<string, ReadonlySet<string>>([
	[
		"OWNER_INBOX",
		new Set(["INBOX", "GMAIL_ACTION", "SEND_EMAIL", "SEND_MESSAGE"]),
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
		"OWNER_SEND_MESSAGE",
		new Set(["CROSS_CHANNEL_SEND", "SEND_MESSAGE"]),
	],
	[
		"CALL_USER",
		new Set(["MAKE_CALL"]),
	],
	[
		"CALL_EXTERNAL",
		new Set(["MAKE_CALL"]),
	],
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
	const normalized = String(actionName ?? "").trim().toUpperCase();
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
