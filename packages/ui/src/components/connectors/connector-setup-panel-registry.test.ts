/**
 * Unit tests for connector setup panel registry: validates token resolution rules.
 */
import { describe, expect, it } from "vitest";
import {
  registerConnectorSetupPanelRule,
  resolveConnectorSetupPanelToken,
} from "./connector-setup-panel-registry.ts";

describe("connector-setup-panel-registry", () => {
  it("resolves built-in telegram, whatsapp, and imessage tokens", () => {
    expect(resolveConnectorSetupPanelToken("telegramaccount")).toBe(
      "telegram-account",
    );
    expect(resolveConnectorSetupPanelToken("plugintelegram")).toBe(
      "telegram-bot",
    );
    expect(resolveConnectorSetupPanelToken("whatsapp")).toBe("whatsapp");
    expect(resolveConnectorSetupPanelToken("imessage")).toBe("imessage");
  });

  it("returns null for unknown connector tokens", () => {
    expect(
      resolveConnectorSetupPanelToken("completely-unknown-token"),
    ).toBeNull();
  });

  it("registers and resolves custom setup panel rule", () => {
    registerConnectorSetupPanelRule({
      token: "discord-local",
      needle: "customdiscordneedle",
      match: "exact",
    });
    expect(resolveConnectorSetupPanelToken("customdiscordneedle")).toBe(
      "discord-local",
    );
  });
});
