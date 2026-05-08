import type {
  ConnectorAccountPrivacy,
  ConnectorAccountRole,
} from "../../api/client-agent";

export interface ConnectorAccountOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

export type ConnectorPrivacyConfirmationRequirement =
  | "none"
  | "typed"
  | "public";

export const CONNECTOR_ACCOUNT_PURPOSE_OPTIONS: readonly ConnectorAccountOption<ConnectorAccountRole>[] =
  [
    {
      value: "OWNER",
      label: "OWNER",
      description: "Use the human owner's identity for this connector.",
    },
    {
      value: "AGENT",
      label: "AGENT",
      description: "Let the agent act through this account.",
    },
    {
      value: "TEAM",
      label: "TEAM",
      description: "Use a shared team identity.",
    },
  ];

export const CONNECTOR_ACCOUNT_PRIVACY_OPTIONS: readonly ConnectorAccountOption<ConnectorAccountPrivacy>[] =
  [
    {
      value: "owner_only",
      label: "Owner only",
      description: "Visible only to the owner. This is the default.",
    },
    {
      value: "team_visible",
      label: "Team visible",
      description: "Team members can see this account is connected.",
    },
    {
      value: "semi_public",
      label: "Semi-public",
      description: "Visible in limited shared connector surfaces.",
    },
    {
      value: "public",
      label: "Public",
      description: "Visible anywhere this connector exposes public identity.",
    },
  ];

export const CONNECTOR_PRIVACY_TYPED_CONFIRMATION = "SHARE";
export const CONNECTOR_PRIVACY_PUBLIC_CONFIRMATION = "PUBLIC";

const CONNECTOR_PRIVACY_RANK: Record<ConnectorAccountPrivacy, number> = {
  owner_only: 0,
  team_visible: 1,
  semi_public: 2,
  public: 3,
};

export function getConnectorPurposeOption(
  value: ConnectorAccountRole | undefined,
): ConnectorAccountOption<ConnectorAccountRole> {
  return (
    CONNECTOR_ACCOUNT_PURPOSE_OPTIONS.find(
      (option) => option.value === value,
    ) ?? CONNECTOR_ACCOUNT_PURPOSE_OPTIONS[0]
  );
}

export function getConnectorPrivacyOption(
  value: ConnectorAccountPrivacy | undefined,
): ConnectorAccountOption<ConnectorAccountPrivacy> {
  return (
    CONNECTOR_ACCOUNT_PRIVACY_OPTIONS.find(
      (option) => option.value === value,
    ) ?? CONNECTOR_ACCOUNT_PRIVACY_OPTIONS[0]
  );
}

export function getConnectorPrivacyConfirmationRequirement(
  current: ConnectorAccountPrivacy | undefined,
  next: ConnectorAccountPrivacy,
): ConnectorPrivacyConfirmationRequirement {
  const resolvedCurrent = current ?? "owner_only";
  if (next === resolvedCurrent) return "none";
  if (next === "public" && resolvedCurrent !== "public") return "public";
  if (CONNECTOR_PRIVACY_RANK[next] > CONNECTOR_PRIVACY_RANK[resolvedCurrent]) {
    return "typed";
  }
  return "none";
}

export function isConnectorPrivacyConfirmationSatisfied(
  requirement: ConnectorPrivacyConfirmationRequirement,
  typedValue: string,
  publicAcknowledged: boolean,
): boolean {
  const normalized = typedValue.trim().toUpperCase();
  if (requirement === "none") return true;
  if (requirement === "typed") {
    return normalized === CONNECTOR_PRIVACY_TYPED_CONFIRMATION;
  }
  return (
    normalized === CONNECTOR_PRIVACY_PUBLIC_CONFIRMATION && publicAcknowledged
  );
}
