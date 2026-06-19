import { describe, expect, it } from "vitest";
import { isConnectorOAuthCallbackEndpoint } from "./connector-oauth-callback-auth";

describe("isConnectorOAuthCallbackEndpoint", () => {
  it("allows unauthenticated OAuth callback GET and POST routes", () => {
    expect(
      isConnectorOAuthCallbackEndpoint(
        "GET",
        "/api/connectors/google/oauth/callback",
      ),
    ).toBe(true);
    expect(
      isConnectorOAuthCallbackEndpoint(
        "POST",
        "/api/connectors/google/oauth/callback/state_123",
      ),
    ).toBe(true);
  });

  it("does not exempt OAuth start/status or unrelated connector account routes", () => {
    expect(
      isConnectorOAuthCallbackEndpoint(
        "POST",
        "/api/connectors/google/oauth/start",
      ),
    ).toBe(false);
    expect(
      isConnectorOAuthCallbackEndpoint(
        "GET",
        "/api/connectors/google/oauth/status",
      ),
    ).toBe(false);
    expect(
      isConnectorOAuthCallbackEndpoint(
        "GET",
        "/api/connectors/google/accounts",
      ),
    ).toBe(false);
  });

  it("does not exempt unsupported methods", () => {
    expect(
      isConnectorOAuthCallbackEndpoint(
        "DELETE",
        "/api/connectors/google/oauth/callback",
      ),
    ).toBe(false);
  });
});
