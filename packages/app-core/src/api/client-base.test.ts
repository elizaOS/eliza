// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  setBootConfig,
} from "../config/boot-config";
import type { ElizaWindow } from "../utils/eliza-globals";
import { ElizaClient } from "./client-base";

function resetRuntimeConfig(): void {
  setBootConfig({ ...DEFAULT_BOOT_CONFIG });
  const elizaWindow = window as ElizaWindow;
  delete elizaWindow.__ELIZAOS_API_TOKEN__;
  delete elizaWindow.__ELIZA_API_TOKEN__;
  delete elizaWindow.__MILADY_API_TOKEN__;
}

describe("ElizaClient.setToken", () => {
  let client: ElizaClient;

  beforeEach(() => {
    resetRuntimeConfig();
    client = new ElizaClient();
  });

  afterEach(() => {
    resetRuntimeConfig();
  });

  it("writes apiToken to bootConfig", () => {
    client.setToken("my-token");
    expect(getBootConfig().apiToken).toBe("my-token");
  });

  it("calls setElizaApiToken with the trimmed token", () => {
    client.setToken("  spaced  ");
    const elizaWindow = window as ElizaWindow;
    expect(elizaWindow.__ELIZAOS_API_TOKEN__).toBe("spaced");
    expect(elizaWindow.__ELIZA_API_TOKEN__).toBe("spaced");
  });

  it("clears apiToken from bootConfig when null", () => {
    client.setToken("my-token");
    client.setToken(null);
    expect(getBootConfig().apiToken).toBeUndefined();
  });

  it("calls clearElizaApiToken when token is null", () => {
    client.setToken("my-token");
    client.setToken(null);
    const elizaWindow = window as ElizaWindow;
    expect(elizaWindow.__ELIZAOS_API_TOKEN__).toBeUndefined();
    expect(elizaWindow.__ELIZA_API_TOKEN__).toBeUndefined();
  });

  it("calls clearElizaApiToken when token is empty string", () => {
    client.setToken("my-token");
    client.setToken("");
    const elizaWindow = window as ElizaWindow;
    expect(elizaWindow.__ELIZAOS_API_TOKEN__).toBeUndefined();
    expect(elizaWindow.__ELIZA_API_TOKEN__).toBeUndefined();
  });

  it("trims whitespace from token", () => {
    client.setToken("  hello  ");
    const elizaWindow = window as ElizaWindow;
    expect(getBootConfig().apiToken).toBe("hello");
    expect(elizaWindow.__ELIZAOS_API_TOKEN__).toBe("hello");
    expect(elizaWindow.__ELIZA_API_TOKEN__).toBe("hello");
  });
});
