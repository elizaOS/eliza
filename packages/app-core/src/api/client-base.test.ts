import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/boot-config", () => {
  let _config: Record<string, unknown> = {};
  return {
    getBootConfig: () => _config,
    setBootConfig: (c: Record<string, unknown>) => {
      _config = { ..._config, ...c };
    },
  };
});

vi.mock("../utils/eliza-globals", () => ({
  setElizaApiToken: vi.fn(),
  clearElizaApiToken: vi.fn(),
  getElizaApiToken: vi.fn(() => null),
  setElizaApiBase: vi.fn(),
  clearElizaApiBase: vi.fn(),
  getElizaApiBase: vi.fn(() => ""),
}));

import { getBootConfig, setBootConfig } from "../config/boot-config";
import {
  clearElizaApiToken,
  setElizaApiToken,
} from "../utils/eliza-globals";

// ElizaClient is a class with constructor side effects; import after mocks.
const { ElizaClient } = await import("./client-base");

describe("ElizaClient.setToken", () => {
  let client: InstanceType<typeof ElizaClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    setBootConfig({});
    client = new ElizaClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("writes apiToken to bootConfig", () => {
    client.setToken("my-token");
    expect(getBootConfig().apiToken).toBe("my-token");
  });

  it("calls setElizaApiToken with the trimmed token", () => {
    client.setToken("  spaced  ");
    expect(setElizaApiToken).toHaveBeenCalledWith("spaced");
  });

  it("clears apiToken from bootConfig when null", () => {
    client.setToken("my-token");
    client.setToken(null);
    expect(getBootConfig().apiToken).toBeUndefined();
  });

  it("calls clearElizaApiToken when token is null", () => {
    client.setToken(null);
    expect(clearElizaApiToken).toHaveBeenCalled();
  });

  it("calls clearElizaApiToken when token is empty string", () => {
    client.setToken("");
    expect(clearElizaApiToken).toHaveBeenCalled();
  });

  it("trims whitespace from token", () => {
    client.setToken("  hello  ");
    expect(getBootConfig().apiToken).toBe("hello");
    expect(setElizaApiToken).toHaveBeenCalledWith("hello");
  });
});
