/**
 * Verifies deterministic normalization of the three Cloud connector status
 * contracts without contacting Cloud or external providers.
 */

import { describe, expect, it } from "vitest";
import { normalizeCloudConnectorConnectionState } from "./useCloudConnectorConnections";

describe("normalizeCloudConnectorConnectionState", () => {
  it("keeps inactive OAuth records disconnectable", () => {
    expect(
      normalizeCloudConnectorConnectionState("oauth", {
        connections: [{ id: "connection-1", status: "error" }],
      }),
    ).toMatchObject({ connected: true, statusText: "Needs attention" });
  });

  it("reports the Discord connection count", () => {
    expect(
      normalizeCloudConnectorConnectionState("discord", {
        connections: [{ id: "one" }, { id: "two" }],
      }),
    ).toMatchObject({ connected: true, statusText: "Connected — 2 bots" });
  });

  it("keeps webhook-configured providers disconnectable after validation failure", () => {
    expect(
      normalizeCloudConnectorConnectionState("credential", {
        connected: false,
        webhookConfigured: true,
        error: "Credential validation failed",
      }),
    ).toEqual({
      connected: true,
      statusText: "Needs attention",
      error: "Credential validation failed",
    });
  });
});
