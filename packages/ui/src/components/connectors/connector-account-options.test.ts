import { describe, expect, it } from "vitest";
import {
  CONNECTOR_OWNER_ROLE_CONFIRMATION,
  CONNECTOR_PLUGIN_MANAGED_MODE_ID,
  CONNECTOR_PRIVACY_PUBLIC_CONFIRMATION,
  CONNECTOR_PRIVACY_TYPED_CONFIRMATION,
  connectorAccountManagementPanelPluginId,
  getConnectorPluginManagedAccountCreateInput,
  getConnectorPluginManagedAccountOption,
  getConnectorPrivacyConfirmationRequirement,
  getConnectorRoleConfirmationRequirement,
  hasConnectorPluginManagedAccounts,
  isConnectorPrivacyConfirmationSatisfied,
  isConnectorRoleConfirmationSatisfied,
  parseConnectorAccountManagementPanelPluginId,
} from "./connector-account-options";

describe("connector account privacy confirmation", () => {
  it("requires typed confirmation when escalating from owner_only", () => {
    expect(
      getConnectorPrivacyConfirmationRequirement("owner_only", "team_visible"),
    ).toBe("typed");
    expect(
      isConnectorPrivacyConfirmationSatisfied(
        "typed",
        CONNECTOR_PRIVACY_TYPED_CONFIRMATION,
        false,
      ),
    ).toBe(true);
  });

  it("requires public confirmation and acknowledgement for public access", () => {
    expect(
      getConnectorPrivacyConfirmationRequirement("owner_only", "public"),
    ).toBe("public");
    expect(
      getConnectorPrivacyConfirmationRequirement("team_visible", "public"),
    ).toBe("public");
    expect(
      isConnectorPrivacyConfirmationSatisfied(
        "public",
        CONNECTOR_PRIVACY_PUBLIC_CONFIRMATION,
        false,
      ),
    ).toBe(false);
    expect(
      isConnectorPrivacyConfirmationSatisfied(
        "public",
        CONNECTOR_PRIVACY_PUBLIC_CONFIRMATION,
        true,
      ),
    ).toBe(true);
  });

  it("requires confirmation for any non-public increase after owner_only", () => {
    expect(
      getConnectorPrivacyConfirmationRequirement("team_visible", "semi_public"),
    ).toBe("typed");
  });

  it("does not require confirmation when reducing visibility", () => {
    expect(
      getConnectorPrivacyConfirmationRequirement("public", "owner_only"),
    ).toBe("none");
  });
});

describe("connector account role confirmation", () => {
  it("requires typed confirmation when promoting an account to OWNER", () => {
    expect(getConnectorRoleConfirmationRequirement("AGENT", "OWNER")).toBe(
      "owner",
    );
    expect(
      isConnectorRoleConfirmationSatisfied(
        "owner",
        CONNECTOR_OWNER_ROLE_CONFIRMATION,
      ),
    ).toBe(true);
    expect(isConnectorRoleConfirmationSatisfied("owner", "agent")).toBe(false);
  });

  it("does not require confirmation when demoting or staying OWNER", () => {
    expect(getConnectorRoleConfirmationRequirement("OWNER", "OWNER")).toBe(
      "none",
    );
    expect(getConnectorRoleConfirmationRequirement("OWNER", "AGENT")).toBe(
      "none",
    );
  });
});

describe("connector plugin-managed account options", () => {
  it("marks account-manager backed connectors as plugin-managed", () => {
    for (const connectorId of [
      "telegram",
      "signal",
      "google",
      "x",
      "twitter",
      "slack",
      "whatsapp",
    ]) {
      expect(hasConnectorPluginManagedAccounts(connectorId)).toBe(true);
      expect(getConnectorPluginManagedAccountOption(connectorId)?.value).toBe(
        CONNECTOR_PLUGIN_MANAGED_MODE_ID,
      );
    }
  });

  it("normalizes X/Twitter to the plugin-x account provider", () => {
    expect(getConnectorPluginManagedAccountOption("twitter")).toMatchObject({
      connectorId: "x",
      provider: "x",
      supportsOAuth: true,
    });
    expect(connectorAccountManagementPanelPluginId("twitter")).toBe(
      "connector-account-management:x:x",
    );
    expect(
      parseConnectorAccountManagementPanelPluginId(
        "connector-account-management:x:x",
      ),
    ).toEqual({ provider: "x", connectorId: "x" });
  });

  it("uses create defaults only for non-OAuth plugin-managed connectors", () => {
    expect(
      getConnectorPluginManagedAccountCreateInput("slack"),
    ).toBeUndefined();
    expect(
      getConnectorPluginManagedAccountCreateInput("telegram"),
    ).toMatchObject({
      role: "AGENT",
      purpose: ["messaging"],
      privacy: "owner_only",
      metadata: {
        managementMode: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
        connectorId: "telegram",
        provider: "telegram",
      },
    });
  });
});
