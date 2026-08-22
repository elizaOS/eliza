/**
 * Pins the cloud settings connector registry to the request and route contracts
 * implemented by the Cloud API. The test is deterministic and does not send
 * credentials or contact provider services.
 */

import { describe, expect, it } from "vitest";
import {
  connectorFieldValidationError,
  getConnectorConfig,
} from "../cloud-connector-contracts";

describe("cloud settings connector contracts", () => {
  it.each([
    ["discord", "/api/v1/discord/connections", "/api/v1/discord/connections"],
    ["telegram", "/api/v1/telegram/connect", "/api/v1/telegram/disconnect"],
    ["whatsapp", "/api/v1/whatsapp/connect", "/api/v1/whatsapp/disconnect"],
    ["twilio", "/api/v1/twilio/connect", "/api/v1/twilio/disconnect"],
    ["blooio", "/api/v1/blooio/connect", "/api/v1/blooio/disconnect"],
  ])(
    "uses the deployed %s connect and disconnect routes",
    (id, connect, disconnect) => {
      const connector = getConnectorConfig(id);
      expect(connector?.connectPath).toBe(connect);
      expect(connector?.disconnectPath).toBe(disconnect);
    },
  );

  it.each(["google", "microsoft"])(
    "uses the generic OAuth contract for %s",
    (id) => {
      const connector = getConnectorConfig(id);
      expect(connector).toMatchObject({
        authMode: "oauth",
        oauthPlatform: id,
        connectPath: `/api/v1/oauth/${id}/initiate`,
        disconnectPath: "/api/v1/oauth/connections",
      });
    },
  );

  it("requires every credential required by the WhatsApp API schema", () => {
    const fields = getConnectorConfig("whatsapp")?.fields;
    expect(
      fields?.filter((field) => field.required).map((field) => field.key),
    ).toEqual(["accessToken", "phoneNumberId", "appSecret"]);
  });

  it("exposes all Blooio API fields without making optional fields required", () => {
    const fields = getConnectorConfig("blooio")?.fields;
    expect(fields?.map((field) => field.key)).toEqual([
      "apiKey",
      "phoneNumber",
      "webhookSecret",
    ]);
    expect(fields?.find((field) => field.key === "apiKey")?.required).toBe(
      true,
    );
    expect(
      fields?.find((field) => field.key === "phoneNumber")?.required,
    ).toBeUndefined();
    expect(
      fields?.find((field) => field.key === "webhookSecret")?.required,
    ).toBeUndefined();
  });

  it("validates Telegram token length and Twilio E.164 phone numbers", () => {
    const telegramToken = getConnectorConfig("telegram")?.fields?.find(
      (field) => field.key === "botToken",
    );
    const twilioPhone = getConnectorConfig("twilio")?.fields?.find(
      (field) => field.key === "phoneNumber",
    );

    expect(telegramToken).toBeDefined();
    expect(twilioPhone).toBeDefined();
    if (!telegramToken || !twilioPhone) return;

    expect(connectorFieldValidationError(telegramToken, "short")).toBe(
      "Bot Token is invalid.",
    );
    expect(
      connectorFieldValidationError(telegramToken, "x".repeat(30)),
    ).toBeNull();
    expect(connectorFieldValidationError(twilioPhone, "555-1234")).toContain(
      "E.164",
    );
    expect(
      connectorFieldValidationError(twilioPhone, "+15551234567"),
    ).toBeNull();
  });
});
