/**
 * Deterministic coverage for first-run Blooio normalization: canonical fields,
 * legacy flat-field compatibility, existing-config completion, and explicit
 * rejection of startup configurations missing service-required values.
 */
import { describe, expect, it } from "vitest";
import { resolveBlooioFirstRunConfig } from "./first-run-routes.ts";

describe("resolveBlooioFirstRunConfig", () => {
  it("normalizes a complete canonical connector", () => {
    expect(
      resolveBlooioFirstRunConfig({
        explicitConnectorRequested: true,
        explicit: {
          apiKey: " api-key ",
          webhookSecret: " webhook-secret ",
          fromNumber: " +15551234567 ",
          channelId: " channel-42 ",
        },
      }),
    ).toEqual({
      requested: true,
      config: {
        apiKey: "api-key",
        webhookSecret: "webhook-secret",
        fromNumber: "+15551234567",
        channelId: "channel-42",
      },
    });
  });

  it("uses legacy flat fields to complete an existing canonical connector", () => {
    expect(
      resolveBlooioFirstRunConfig({
        current: {
          webhookSecret: "persisted-secret",
          channelId: "persisted-channel",
        },
        blooioApiKey: "legacy-key",
        blooioPhoneNumber: "+15557654321",
      }),
    ).toEqual({
      requested: true,
      config: {
        apiKey: "legacy-key",
        webhookSecret: "persisted-secret",
        fromNumber: "+15557654321",
        channelId: "persisted-channel",
      },
    });
  });

  it("prefers canonical connector fields over legacy aliases", () => {
    const result = resolveBlooioFirstRunConfig({
      explicitConnectorRequested: true,
      explicit: {
        apiKey: "canonical-key",
        webhookSecret: "canonical-secret",
        phoneNumber: "+15550000000",
        channelId: "canonical-channel",
      },
      blooioApiKey: "legacy-key",
      blooioWebhookSecret: "legacy-secret",
      blooioPhoneNumber: "+15551111111",
      blooioChannelId: "legacy-channel",
    });

    expect(result).toEqual({
      requested: true,
      config: {
        apiKey: "canonical-key",
        webhookSecret: "canonical-secret",
        fromNumber: "+15550000000",
        channelId: "canonical-channel",
      },
    });
  });

  it("rejects a partial connector instead of fabricating required values", () => {
    expect(
      resolveBlooioFirstRunConfig({
        explicitConnectorRequested: true,
        explicit: { apiKey: "api-key", fromNumber: "+15551234567" },
      }),
    ).toEqual({
      requested: true,
      error:
        "Incomplete Blooio connector configuration; missing: webhookSecret, channelId",
    });
  });

  it("does nothing when first-run has no Blooio configuration", () => {
    expect(resolveBlooioFirstRunConfig({})).toEqual({ requested: false });
  });
});
