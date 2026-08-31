/**
 * Guards the generated Blooio connector setup contract consumed by plugin
 * discovery and the setup UI. The harness reads the committed first-party
 * artifacts and validates the real registry entry without mocks.
 */
import { describe, expect, it } from "vitest";
import channelPluginMap from "./channel-plugin-map.json" with { type: "json" };
import generatedRegistry from "./generated.json" with { type: "json" };
import { connectorEntrySchema } from "./schema";

const BLOOIO_CREDENTIAL_KEYS = [
  "IMESSAGE_BLOOIO_API_KEY",
  "IMESSAGE_BLOOIO_WEBHOOK_SECRET",
  "IMESSAGE_BLOOIO_FROM_NUMBER",
  "IMESSAGE_BLOOIO_CHANNEL_ID",
] as const;

describe("Blooio first-party registry contract", () => {
  it("resolves the blooio channel to the iMessage plugin", () => {
    expect(channelPluginMap.blooio).toBe("@elizaos/plugin-imessage");
  });

  it("publishes every required Blooio credential for conditional setup", () => {
    const rawEntry = generatedRegistry.entries.find(
      (entry) => entry.id === "imessage",
    );
    const entry = connectorEntrySchema.parse(rawEntry);

    expect(entry.npmName).toBe("@elizaos/plugin-imessage");
    expect(entry.channels).toContain("blooio");
    expect(entry.config.IMESSAGE_TRANSPORT).toMatchObject({
      type: "select",
      required: true,
      default: "native",
    });
    expect(entry.auth).toEqual({
      kind: "credentials",
      credentialKeys: BLOOIO_CREDENTIAL_KEYS,
    });

    for (const key of BLOOIO_CREDENTIAL_KEYS) {
      expect(entry.config[key]).toMatchObject({
        required: true,
        visible: { key: "IMESSAGE_TRANSPORT", equals: "blooio" },
      });
    }
  });
});
