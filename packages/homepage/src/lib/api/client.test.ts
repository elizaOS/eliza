import { afterEach, describe, expect, it, vi } from "vitest";
import { ELIZACLOUD_DEFAULT_URL, getElizacloudUrl } from "./client";

describe("elizacloud API client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults homepage traffic to the API domain", () => {
    expect(ELIZACLOUD_DEFAULT_URL).toBe("https://api.elizacloud.ai");
  });

  it("normalizes configured API URLs", () => {
    vi.stubEnv("VITE_ELIZACLOUD_API_URL", "http://127.0.0.1:8787/");

    expect(getElizacloudUrl()).toBe("http://127.0.0.1:8787");
  });
});
