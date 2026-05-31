import { describe, expect, test } from "bun:test";
import { requiresHeadscaleRoute } from "../docker-sandbox-provider";

describe("requiresHeadscaleRoute", () => {
  test("does not require Headscale routing when Headscale is not configured", () => {
    expect(requiresHeadscaleRoute({})).toBe(false);
    expect(requiresHeadscaleRoute({ HEADSCALE_API_KEY: "" })).toBe(false);
  });

  test("requires a persisted headscale route when Headscale is configured", () => {
    expect(requiresHeadscaleRoute({ HEADSCALE_API_KEY: "secret" })).toBe(true);
  });

  test("allows explicit legacy bridge-host fallback", () => {
    expect(
      requiresHeadscaleRoute({
        HEADSCALE_API_KEY: "secret",
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
      }),
    ).toBe(false);
    expect(
      requiresHeadscaleRoute({
        HEADSCALE_API_KEY: "secret",
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "true",
      }),
    ).toBe(false);
  });
});
