import { describe, expect, it } from "vitest";
import type { ConnectorAccountRecord } from "../../api/client-agent";
import {
  buildConnectorSendAsMetadata,
  CONNECTOR_SEND_AS_METADATA_KEY,
  connectorWriteConfirmationKey,
  isConnectorAccountUsable,
  isLikelyAccountRequiredError,
  mergeConnectorSendAsMetadata,
  shouldShowConnectorAccountPicker,
} from "./connector-send-as";

function account(
  id: string,
  overrides: Partial<ConnectorAccountRecord> = {},
): ConnectorAccountRecord {
  return {
    id,
    provider: "telegram",
    connectorId: "telegram",
    label: id,
    status: "connected",
    enabled: true,
    ...overrides,
  };
}

describe("connector send-as helpers", () => {
  it("only shows the picker when connector context has multiple accounts", () => {
    const context = { provider: "telegram", source: "telegram" };

    expect(shouldShowConnectorAccountPicker(null, [account("a")])).toBe(false);
    expect(shouldShowConnectorAccountPicker(context, [account("a")])).toBe(
      false,
    );
    expect(
      shouldShowConnectorAccountPicker(context, [account("a"), account("b")]),
    ).toBe(true);
  });

  it("builds backwards-compatible send metadata", () => {
    const metadata = buildConnectorSendAsMetadata(
      {
        provider: "telegram",
        connectorId: "telegram",
        source: "telegram",
        channel: "room-1",
      },
      account("owner", {
        handle: "@owner",
        isDefault: true,
        purpose: "OWNER",
      }),
    );

    expect(metadata?.accountId).toBe("owner");
    expect(metadata?.source).toBe("telegram");
    expect(metadata?.channel).toBe("room-1");
    expect(metadata?.[CONNECTOR_SEND_AS_METADATA_KEY]).toMatchObject({
      accountId: "owner",
      source: "telegram",
      channel: "room-1",
      provider: "telegram",
      connectorId: "telegram",
      handle: "@owner",
      isDefault: true,
      purpose: "OWNER",
    });
  });

  it("merges send-as metadata without dropping existing routing metadata", () => {
    const merged = mergeConnectorSendAsMetadata(
      { uiTab: "chat", __responseContext: { primaryContext: "general" } },
      buildConnectorSendAsMetadata(
        { provider: "signal", source: "signal" },
        account("work"),
      ),
    );

    expect(merged?.uiTab).toBe("chat");
    expect(merged?.accountId).toBe("work");
    expect(merged?.__responseContext).toEqual({ primaryContext: "general" });
  });

  it("checks account usability and account-required errors", () => {
    expect(isConnectorAccountUsable(account("connected"))).toBe(true);
    expect(
      isConnectorAccountUsable(account("reauth", { status: "needs-reauth" })),
    ).toBe(false);
    expect(isConnectorAccountUsable(account("off", { enabled: false }))).toBe(
      false,
    );
    expect(isLikelyAccountRequiredError(new Error("choose an account"))).toBe(
      true,
    );
    expect(isLikelyAccountRequiredError(new Error("network failed"))).toBe(
      false,
    );
  });

  it("keys write confirmation by source, channel, and account", () => {
    expect(
      connectorWriteConfirmationKey(
        { provider: "discord", source: "discord", channel: "123" },
        account("team"),
      ),
    ).toBe("discord:123:team");
  });
});
