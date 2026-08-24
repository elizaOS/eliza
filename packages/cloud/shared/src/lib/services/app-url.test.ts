import { describe, expect, it, vi } from "vitest";

vi.mock("../config/containers-env.js", () => ({
  containersEnv: { appsPublicBaseDomain: vi.fn() },
}));

import { containersEnv } from "../config/containers-env.js";
import { deriveAppPublicUrl } from "./app-url.js";

describe("deriveAppPublicUrl", () => {
  it("returns null when domain not configured", () => {
    vi.mocked(containersEnv.appsPublicBaseDomain).mockReturnValue("");
    expect(deriveAppPublicUrl("123e4567-e89b-12d3-a456-426614174000")).toBeNull();
  });

  it("derives hostname and url from containerId", () => {
    vi.mocked(containersEnv.appsPublicBaseDomain).mockReturnValue("apps.eliza.app");
    const res = deriveAppPublicUrl("123e4567-e89b-12d3-a456-426614174000");
    expect(res).toEqual({
      hostname: "123e4567.apps.eliza.app",
      url: "https://123e4567.apps.eliza.app",
    });
  });

  it("handles short id without dashes", () => {
    vi.mocked(containersEnv.appsPublicBaseDomain).mockReturnValue("example.com");
    const res = deriveAppPublicUrl("abcdef1234567890");
    expect(res?.hostname).toBe("abcdef12.example.com");
  });
});
