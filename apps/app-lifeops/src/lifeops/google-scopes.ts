import {
  LIFEOPS_GOOGLE_CAPABILITIES,
  type LifeOpsGoogleCapability,
} from "../contracts/index.js";

export const GOOGLE_OPENID_SCOPES = ["openid", "email", "profile"] as const;
export const GOOGLE_CALENDAR_READ_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly";
export const GOOGLE_CALENDAR_WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";
export const GOOGLE_GMAIL_METADATA_SCOPE =
  "https://www.googleapis.com/auth/gmail.metadata";
export const GOOGLE_GMAIL_READ_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_GMAIL_SEND_SCOPE =
  "https://www.googleapis.com/auth/gmail.send";
export const GOOGLE_GMAIL_MODIFY_SCOPE =
  "https://www.googleapis.com/auth/gmail.modify";
export const GOOGLE_GMAIL_SETTINGS_BASIC_SCOPE =
  "https://www.googleapis.com/auth/gmail.settings.basic";

const GOOGLE_CAPABILITY_SCOPE_MAP: Record<LifeOpsGoogleCapability, string[]> = {
  "google.basic_identity": [...GOOGLE_OPENID_SCOPES],
  "google.calendar.read": [GOOGLE_CALENDAR_READ_SCOPE],
  "google.calendar.write": [GOOGLE_CALENDAR_WRITE_SCOPE],
  // Reading message bodies requires gmail.readonly rather than gmail.metadata.
  "google.gmail.triage": [GOOGLE_GMAIL_READ_SCOPE],
  "google.gmail.send": [GOOGLE_GMAIL_SEND_SCOPE],
  // Managing labels, filters, and archive/trash flows (auto-unsubscribe).
  "google.gmail.manage": [
    GOOGLE_GMAIL_MODIFY_SCOPE,
    GOOGLE_GMAIL_SETTINGS_BASIC_SCOPE,
  ],
};

export const DEFAULT_GOOGLE_CONNECTOR_CAPABILITIES: LifeOpsGoogleCapability[] =
  [...LIFEOPS_GOOGLE_CAPABILITIES];

export function normalizeGoogleCapabilities(
  value: Iterable<unknown> | undefined,
  defaultCapabilities: readonly LifeOpsGoogleCapability[] = DEFAULT_GOOGLE_CONNECTOR_CAPABILITIES,
): LifeOpsGoogleCapability[] {
  const allowed = new Set<LifeOpsGoogleCapability>(LIFEOPS_GOOGLE_CAPABILITIES);
  const normalized: LifeOpsGoogleCapability[] = [];
  const seen = new Set<LifeOpsGoogleCapability>();
  const source = value ? Array.from(value) : [...defaultCapabilities];

  for (const candidate of source) {
    if (typeof candidate !== "string") {
      continue;
    }
    if (!allowed.has(candidate as LifeOpsGoogleCapability)) {
      continue;
    }
    const capability = candidate as LifeOpsGoogleCapability;
    if (seen.has(capability)) {
      continue;
    }
    seen.add(capability);
    normalized.push(capability);
  }

  if (!seen.has("google.basic_identity")) {
    normalized.unshift("google.basic_identity");
  }

  return normalized;
}

export function unionGoogleCapabilities(
  ...capabilityLists: Array<readonly LifeOpsGoogleCapability[] | undefined>
): LifeOpsGoogleCapability[] {
  const merged: LifeOpsGoogleCapability[] = [];
  const seen = new Set<LifeOpsGoogleCapability>();
  for (const list of capabilityLists) {
    if (!list) {
      continue;
    }
    for (const capability of normalizeGoogleCapabilities(list)) {
      if (seen.has(capability)) continue;
      seen.add(capability);
      merged.push(capability);
    }
  }
  return merged.length > 0
    ? merged
    : [...DEFAULT_GOOGLE_CONNECTOR_CAPABILITIES];
}

export function googleCapabilitiesToScopes(
  capabilities: readonly LifeOpsGoogleCapability[],
): string[] {
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const capability of normalizeGoogleCapabilities(capabilities)) {
    for (const scope of GOOGLE_CAPABILITY_SCOPE_MAP[capability]) {
      if (seen.has(scope)) continue;
      seen.add(scope);
      scopes.push(scope);
    }
  }
  return scopes;
}

export function googleScopesToCapabilities(
  scopes: readonly string[],
): LifeOpsGoogleCapability[] {
  const granted = new Set(scopes.map((scope) => scope.trim()).filter(Boolean));
  const capabilities: LifeOpsGoogleCapability[] = [];

  const hasIdentity = GOOGLE_OPENID_SCOPES.some((scope) => granted.has(scope));
  if (hasIdentity) {
    capabilities.push("google.basic_identity");
  }

  const hasCalendarRead =
    granted.has(GOOGLE_CALENDAR_READ_SCOPE) ||
    granted.has(GOOGLE_CALENDAR_WRITE_SCOPE);
  if (hasCalendarRead) {
    capabilities.push("google.calendar.read");
  }

  if (granted.has(GOOGLE_CALENDAR_WRITE_SCOPE)) {
    capabilities.push("google.calendar.write");
  }

  const hasGmailTriage =
    granted.has(GOOGLE_GMAIL_METADATA_SCOPE) ||
    granted.has(GOOGLE_GMAIL_READ_SCOPE);
  if (hasGmailTriage) {
    capabilities.push("google.gmail.triage");
  }

  if (granted.has(GOOGLE_GMAIL_SEND_SCOPE)) {
    capabilities.push("google.gmail.send");
  }
  if (
    granted.has(GOOGLE_GMAIL_MODIFY_SCOPE) &&
    granted.has(GOOGLE_GMAIL_SETTINGS_BASIC_SCOPE)
  ) {
    capabilities.push("google.gmail.manage");
  }
  return capabilities;
}
