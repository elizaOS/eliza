const OWNER_PREFIX = "OWNER_";

const ACTION_FAMILIES = [
  ["SEND_MESSAGE", "OWNER_SEND_MESSAGE", "CROSS_CHANNEL_SEND"],
  ["INBOX", "OWNER_INBOX"],
  ["SCREEN_TIME", "OWNER_SCREEN_TIME"],
  ["CALENDAR_ACTION", "OWNER_CALENDAR"],
  ["INTENT_SYNC", "PUBLISH_DEVICE_INTENT"],
];

function normalizeActionName(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function withoutOwnerPrefix(value: string): string {
  return value.startsWith(OWNER_PREFIX) ? value.slice(OWNER_PREFIX.length) : value;
}

function actionFamily(value: string): Set<string> {
  const normalized = normalizeActionName(value);
  const base = withoutOwnerPrefix(normalized);
  const family = new Set<string>([normalized, base]);
  for (const members of ACTION_FAMILIES) {
    if (members.includes(normalized) || members.includes(base)) {
      for (const member of members) {
        family.add(member);
        family.add(withoutOwnerPrefix(member));
      }
    }
  }
  return family;
}

export function actionsAreScenarioEquivalent(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const leftFamily = actionFamily(left ?? "");
  const rightFamily = actionFamily(right ?? "");
  for (const member of leftFamily) {
    if (rightFamily.has(member)) {
      return true;
    }
  }
  return false;
}

export function actionMatchesScenarioExpectation(
  candidate: string | undefined,
  acceptedActions: string[],
): boolean {
  return acceptedActions.some((acceptedAction) =>
    actionsAreScenarioEquivalent(candidate, acceptedAction),
  );
}
