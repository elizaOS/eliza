/**
 * Browser-safe Google Workspace capability catalog for connector OAuth UI.
 * Capability ids mirror `@elizaos/plugin-google-workspace` `GOOGLE_CAPABILITIES`.
 */

export const GOOGLE_WORKSPACE_CAPABILITY_GROUPS = [
  "gmail",
  "calendar",
  "drive",
  "meet",
] as const;

export type GoogleWorkspaceCapabilityGroup =
  (typeof GOOGLE_WORKSPACE_CAPABILITY_GROUPS)[number];

export type GoogleWorkspaceCapabilityId =
  | "gmail.read"
  | "gmail.send"
  | "gmail.manage"
  | "calendar.read"
  | "calendar.write"
  | "drive.read"
  | "drive.write"
  | "meet.create"
  | "meet.read";

export interface GoogleWorkspaceCapabilityOption {
  id: GoogleWorkspaceCapabilityId;
  group: GoogleWorkspaceCapabilityGroup;
  label: string;
  description: string;
}

export const GOOGLE_WORKSPACE_CAPABILITY_OPTIONS: readonly GoogleWorkspaceCapabilityOption[] =
  [
    {
      id: "gmail.read",
      group: "gmail",
      label: "Read Gmail",
      description: "Search and read Gmail message metadata and bodies.",
    },
    {
      id: "gmail.send",
      group: "gmail",
      label: "Send Gmail",
      description: "Send email through Gmail for the selected account.",
    },
    {
      id: "gmail.manage",
      group: "gmail",
      label: "Manage Gmail",
      description:
        "Modify Gmail labels, message state, and basic mail settings.",
    },
    {
      id: "calendar.read",
      group: "calendar",
      label: "Read Calendar",
      description: "List Google Calendar events for the selected account.",
    },
    {
      id: "calendar.write",
      group: "calendar",
      label: "Write Calendar",
      description: "Create and update Google Calendar events.",
    },
    {
      id: "drive.read",
      group: "drive",
      label: "Read Drive",
      description: "Search and read Google Drive file metadata.",
    },
    {
      id: "drive.write",
      group: "drive",
      label: "Write Drive",
      description:
        "Create or update files opened or created by this integration.",
    },
    {
      id: "meet.create",
      group: "meet",
      label: "Create Meet Spaces",
      description:
        "Create Google Meet spaces and end active conferences created by the user.",
    },
    {
      id: "meet.read",
      group: "meet",
      label: "Read Meet Artifacts",
      description:
        "Read Google Meet spaces, conference records, participants, transcripts, and recordings.",
    },
  ];

const GROUP_LABELS: Record<GoogleWorkspaceCapabilityGroup, string> = {
  gmail: "Gmail",
  calendar: "Calendar",
  drive: "Drive",
  meet: "Meet",
};

export function googleWorkspaceCapabilityGroupLabel(
  group: GoogleWorkspaceCapabilityGroup,
): string {
  return GROUP_LABELS[group];
}

export function isGoogleWorkspaceCapabilityId(
  value: unknown,
): value is GoogleWorkspaceCapabilityId {
  return (
    typeof value === "string" &&
    GOOGLE_WORKSPACE_CAPABILITY_OPTIONS.some((option) => option.id === value)
  );
}

export function normalizeGoogleWorkspaceCapabilitySelection(
  capabilities: Iterable<unknown>,
): GoogleWorkspaceCapabilityId[] {
  const normalized: GoogleWorkspaceCapabilityId[] = [];
  const seen = new Set<GoogleWorkspaceCapabilityId>();
  for (const candidate of capabilities) {
    if (!isGoogleWorkspaceCapabilityId(candidate) || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}

export function googleWorkspaceCapabilitiesFromAccountMetadata(
  metadata: Record<string, unknown> | undefined,
): GoogleWorkspaceCapabilityId[] {
  if (!metadata) return [];
  const granted = metadata.grantedCapabilities;
  if (!Array.isArray(granted)) return [];
  return normalizeGoogleWorkspaceCapabilitySelection(granted);
}
