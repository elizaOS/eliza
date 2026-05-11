import { describe, expect, it } from "vitest";
import { codingAgentRouteRegistration } from "../../src/register-routes.ts";

describe("register-routes — bundler-safe sentinel export", () => {
  it("exposes the registration as an awaitable Promise that bundlers can latch onto", () => {
    expect(codingAgentRouteRegistration).toBeDefined();
    expect(typeof (codingAgentRouteRegistration as Promise<void>).then).toBe(
      "function",
    );
  });

  it("registration completes without throwing", async () => {
    await expect(codingAgentRouteRegistration).resolves.toBeUndefined();
  });
});
