import { describe, expect, it } from "vitest";
import {
  CONNECTOR_PRIVACY_PUBLIC_CONFIRMATION,
  CONNECTOR_PRIVACY_TYPED_CONFIRMATION,
  getConnectorPrivacyConfirmationRequirement,
  isConnectorPrivacyConfirmationSatisfied,
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
