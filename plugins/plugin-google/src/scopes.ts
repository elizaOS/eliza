export const GOOGLE_CAPABILITIES = [
  "gmail.read",
  "gmail.send",
  "gmail.manage",
  "calendar.read",
  "calendar.write",
  "drive.read",
  "drive.write",
  "meet.create",
  "meet.read",
] as const;

export type GoogleCapability = (typeof GOOGLE_CAPABILITIES)[number];

export const GOOGLE_CAPABILITY_GROUPS = ["gmail", "calendar", "drive", "meet"] as const;

export type GoogleCapabilityGroup = (typeof GOOGLE_CAPABILITY_GROUPS)[number];

export const GOOGLE_OAUTH_SCOPES = {
  gmail: {
    read: "https://www.googleapis.com/auth/gmail.readonly",
    send: "https://www.googleapis.com/auth/gmail.send",
    manage: "https://www.googleapis.com/auth/gmail.modify",
    settings: "https://www.googleapis.com/auth/gmail.settings.basic",
  },
  calendar: {
    read: "https://www.googleapis.com/auth/calendar.readonly",
    write: "https://www.googleapis.com/auth/calendar.events",
  },
  drive: {
    read: "https://www.googleapis.com/auth/drive.readonly",
    write: "https://www.googleapis.com/auth/drive.file",
  },
  meet: {
    create: "https://www.googleapis.com/auth/meetings.space.created",
    read: "https://www.googleapis.com/auth/meetings.space.readonly",
  },
  profile: {
    email: "https://www.googleapis.com/auth/userinfo.email",
    profile: "https://www.googleapis.com/auth/userinfo.profile",
    openid: "openid",
  },
} as const;

export interface GoogleCapabilityMetadata {
  id: GoogleCapability;
  group: GoogleCapabilityGroup;
  label: string;
  description: string;
  scopes: readonly string[];
}

export const GOOGLE_CAPABILITY_SCOPES = {
  "gmail.read": [GOOGLE_OAUTH_SCOPES.gmail.read],
  "gmail.send": [GOOGLE_OAUTH_SCOPES.gmail.send],
  "gmail.manage": [GOOGLE_OAUTH_SCOPES.gmail.manage, GOOGLE_OAUTH_SCOPES.gmail.settings],
  "calendar.read": [GOOGLE_OAUTH_SCOPES.calendar.read],
  "calendar.write": [GOOGLE_OAUTH_SCOPES.calendar.write],
  "drive.read": [GOOGLE_OAUTH_SCOPES.drive.read],
  "drive.write": [GOOGLE_OAUTH_SCOPES.drive.write],
  "meet.create": [GOOGLE_OAUTH_SCOPES.meet.create],
  "meet.read": [GOOGLE_OAUTH_SCOPES.meet.read],
} as const satisfies Record<GoogleCapability, readonly string[]>;

const GOOGLE_CAPABILITY_DETAILS: Record<
  GoogleCapability,
  Omit<GoogleCapabilityMetadata, "id" | "group" | "scopes">
> = {
  "gmail.read": {
    label: "Read Gmail",
    description: "Search and read Gmail message metadata and message bodies.",
  },
  "gmail.send": {
    label: "Send Gmail",
    description: "Send email through Gmail for the selected account.",
  },
  "gmail.manage": {
    label: "Manage Gmail",
    description: "Modify Gmail labels, message state, and basic mail settings.",
  },
  "calendar.read": {
    label: "Read Calendar",
    description: "List Google Calendar events for the selected account.",
  },
  "calendar.write": {
    label: "Write Calendar",
    description: "Create and update Google Calendar events.",
  },
  "drive.read": {
    label: "Read Drive",
    description: "Search and read Google Drive file metadata.",
  },
  "drive.write": {
    label: "Write Drive",
    description: "Create or update files opened or created by this integration.",
  },
  "meet.create": {
    label: "Create Meet Spaces",
    description: "Create Google Meet spaces and end active conferences created by the user.",
  },
  "meet.read": {
    label: "Read Meet Artifacts",
    description:
      "Read Google Meet spaces, conference records, participants, transcripts, and recordings.",
  },
};

export const GOOGLE_CAPABILITY_METADATA = GOOGLE_CAPABILITIES.reduce(
  (metadata, capability) => {
    metadata[capability] = {
      id: capability,
      group: capability.split(".")[0] as GoogleCapabilityGroup,
      ...GOOGLE_CAPABILITY_DETAILS[capability],
      scopes: GOOGLE_CAPABILITY_SCOPES[capability],
    };
    return metadata;
  },
  {} as Record<GoogleCapability, GoogleCapabilityMetadata>
);

export const GOOGLE_CAPABILITY_DESCRIPTORS = GOOGLE_CAPABILITY_METADATA;

export const GOOGLE_IDENTITY_SCOPES = [
  GOOGLE_OAUTH_SCOPES.profile.openid,
  GOOGLE_OAUTH_SCOPES.profile.email,
  GOOGLE_OAUTH_SCOPES.profile.profile,
] as const;

const GOOGLE_CAPABILITY_SET = new Set<string>(GOOGLE_CAPABILITIES);

export function isGoogleCapability(value: unknown): value is GoogleCapability {
  return typeof value === "string" && GOOGLE_CAPABILITY_SET.has(value);
}

export function normalizeGoogleCapabilities(
  capabilities: Iterable<unknown> | undefined
): GoogleCapability[] {
  const normalized: GoogleCapability[] = [];
  const seen = new Set<GoogleCapability>();

  for (const candidate of capabilities ?? []) {
    if (!isGoogleCapability(candidate) || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
  }

  return normalized;
}

export interface GoogleScopeDerivationOptions {
  includeIdentityScopes?: boolean;
}

export function scopesForGoogleCapabilities(
  capabilities: readonly GoogleCapability[],
  options: GoogleScopeDerivationOptions = {}
): string[] {
  const selected = new Set<string>();

  if (options.includeIdentityScopes !== false) {
    for (const scope of GOOGLE_IDENTITY_SCOPES) {
      selected.add(scope);
    }
  }

  for (const capability of normalizeGoogleCapabilities(capabilities)) {
    for (const scope of GOOGLE_CAPABILITY_METADATA[capability].scopes) {
      selected.add(scope);
    }
  }

  return Array.from(selected);
}

export function capabilityGroups(
  capabilities: readonly GoogleCapability[]
): GoogleCapabilityGroup[] {
  const groups = new Set<GoogleCapabilityGroup>();
  for (const capability of normalizeGoogleCapabilities(capabilities)) {
    groups.add(capability.split(".")[0] as GoogleCapabilityGroup);
  }
  return Array.from(groups);
}

export const GOOGLE_DEFAULT_CONNECT_SCOPES = scopesForGoogleCapabilities([], {
  includeIdentityScopes: true,
});
