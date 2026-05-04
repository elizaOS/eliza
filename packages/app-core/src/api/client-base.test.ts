// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  setBootConfig,
} from "../config/boot-config";
import { clearElizaApiToken, getElizaApiToken } from "../utils/eliza-globals";
import { ElizaClient } from "./client-base";

describe("ElizaClient.setToken", () => {
  let client: ElizaClient;

  beforeEach(() => {
    clearElizaApiToken();
    setBootConfig(DEFAULT_BOOT_CONFIG);
    client = new ElizaClient();
  });

  afterEach(() => {
    clearElizaApiToken();
    setBootConfig(DEFAULT_BOOT_CONFIG);
  });

  it("writes apiToken to bootConfig", () => {
    client.setToken("my-token");
    expect(getBootConfig().apiToken).toBe("my-token");
  });

  it("calls setElizaApiToken with the trimmed token", () => {
    client.setToken("  spaced  ");
    expect(getElizaApiToken()).toBe("spaced");
  });

  it("clears apiToken from bootConfig when null", () => {
    client.setToken("my-token");
    client.setToken(null);
    expect(getBootConfig().apiToken).toBeUndefined();
  });

  it("calls clearElizaApiToken when token is null", () => {
    client.setToken("my-token");
    client.setToken(null);
    expect(getElizaApiToken()).toBeUndefined();
  });

  it("calls clearElizaApiToken when token is empty string", () => {
    client.setToken("my-token");
    client.setToken("");
    expect(getElizaApiToken()).toBeUndefined();
  });

  it("trims whitespace from token", () => {
    client.setToken("  hello  ");
    expect(getBootConfig().apiToken).toBe("hello");
    expect(getElizaApiToken()).toBe("hello");
  });

  it("routes REST requests through the configured request transport", async () => {
    client.setBaseUrl("http://127.0.0.1:31337");
    const seen: Array<{ url: string; init: RequestInit }> = [];
    client.setRequestTransport({
      async request(url, init) {
        seen.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    await expect(client.fetch("/api/test")).resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://127.0.0.1:31337/api/test");
  });
});
