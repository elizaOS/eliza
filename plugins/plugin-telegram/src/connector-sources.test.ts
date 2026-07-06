/**
 * Guards the telegram connector-source registration contract (#14711): the
 * plugin must declare the flat-field identity projection (fromId/entityName)
 * and world-id key (telegramChatId) so core role resolution can derive sender
 * identity and world from telegram memories without connector literals.
 */
import { describe, expect, it } from "vitest";
import telegramPlugin from "./index";

describe("telegram connectorSources registration", () => {
  it("declares the identity mapping and world-id keys role resolution depends on", () => {
    const source = telegramPlugin.connectorSources?.find(
      (entry) => entry.source === "telegram",
    );
    expect(source).toBeDefined();
    expect(source?.identityMetadataMapping).toEqual({
      userIdField: "fromId",
      nameField: "entityName",
    });
    expect(source?.worldIdMetadataKeys).toEqual(["telegramChatId"]);
  });
});
