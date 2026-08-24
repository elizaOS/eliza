/**
 * Verifies the lazily composed default owner client: credential resolution
 * (Steward session preferred over the client REST token), the configured
 * cloudApiBase versus canonical-API-origin fallback, and the fail-closed
 * authentication error — asserted against a real RemoteControlCloudClient
 * request, not mocks echoing inputs back.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import { client } from "./client";
import { DEFAULT_DIRECT_CLOUD_API_BASE_URL } from "./direct-cloud-endpoints";
import {
  RemoteControlAuthenticationRequiredError,
  RemoteControlCloudClient,
} from "./remote-control-cloud-client";
import {
  createDefaultRemoteControlCloudClient,
  getDefaultRemoteControlCloudConnection,
} from "./remote-control-cloud-default";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";

describe("getDefaultRemoteControlCloudConnection", () => {
  let previousBootConfig: ReturnType<typeof getBootConfig>;

  beforeEach(() => {
    previousBootConfig = getBootConfig();
    window.localStorage.clear();
  });

  afterEach(() => {
    client.setToken(null);
    setBootConfig(previousBootConfig);
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  function seedStewardSession(token: string): void {
    window.localStorage.setItem(STEWARD_TOKEN_KEY, token);
  }

  it("fails closed with the typed error when neither Steward nor REST credentials exist", () => {
    let caught: unknown;
    try {
      getDefaultRemoteControlCloudConnection();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RemoteControlAuthenticationRequiredError);
    expect(caught).toMatchObject({
      name: "RemoteControlAuthenticationRequiredError",
      message: "Sign in to Eliza Cloud to manage devices.",
    });
  });

  it("still fails closed when the stored Steward session is whitespace only", () => {
    seedStewardSession("   ");

    expect(() => getDefaultRemoteControlCloudConnection()).toThrow(
      RemoteControlAuthenticationRequiredError,
    );
  });

  it("prefers the stored Steward session over the client REST token", () => {
    seedStewardSession("steward-jwt-1");
    client.setToken("rest-api-key");
    setBootConfig({
      ...previousBootConfig,
      cloudApiBase: "https://remote-control.example.test",
    });

    expect(getDefaultRemoteControlCloudConnection()).toEqual({
      baseUrl: "https://remote-control.example.test",
      authToken: "steward-jwt-1",
    });
  });

  it("falls back to the client REST token when no Steward session exists", () => {
    client.setToken("rest-api-key");

    const connection = getDefaultRemoteControlCloudConnection();
    expect(connection.authToken).toBe("rest-api-key");
  });

  it("returns the configured cloudApiBase verbatim when signed in", () => {
    seedStewardSession("steward-jwt-1");
    setBootConfig({
      ...previousBootConfig,
      cloudApiBase: "https://remote-control.example.test",
    });

    expect(getDefaultRemoteControlCloudConnection()).toEqual({
      baseUrl: "https://remote-control.example.test",
      authToken: "steward-jwt-1",
    });
  });

  it("falls back to the canonical direct Cloud API origin for blank and unset cloudApiBase", () => {
    seedStewardSession("steward-jwt-1");
    setBootConfig({ ...previousBootConfig, cloudApiBase: "" });
    expect(getDefaultRemoteControlCloudConnection().baseUrl).toBe(
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );

    setBootConfig({ ...previousBootConfig, cloudApiBase: undefined });
    expect(getDefaultRemoteControlCloudConnection().baseUrl).toBe(
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
  });

  it("composes an authenticated client that targets the resolved authority", async () => {
    seedStewardSession("steward-jwt-1");
    setBootConfig({
      ...previousBootConfig,
      cloudApiBase: "https://remote-control.example.test/",
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            success: true,
            data: { ownerId: OWNER_ID, hosts: [] },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const remoteClient = createDefaultRemoteControlCloudClient();

    expect(remoteClient).toBeInstanceOf(RemoteControlCloudClient);
    await expect(remoteClient.listHosts()).resolves.toEqual({
      ownerId: OWNER_ID,
      hosts: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://remote-control.example.test/api/v1/remote/hosts",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        accept: "application/json",
        authorization: "Bearer steward-jwt-1",
      }),
    });
  });

  it("refuses to compose a client without credentials", () => {
    expect(() => createDefaultRemoteControlCloudClient()).toThrow(
      RemoteControlAuthenticationRequiredError,
    );
  });
});
