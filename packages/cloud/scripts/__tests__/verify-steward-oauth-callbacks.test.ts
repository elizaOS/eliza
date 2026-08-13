/**
 * Steward canonical-callback deploy probe tests use deterministic fetch fakes;
 * no provider request or tenant mutation leaves the process.
 */

import { describe, expect, test } from "bun:test";
import {
  parseStewardCallbackProbeArgs,
  verifyStewardOAuthCallbacks,
} from "../verify-steward-oauth-callbacks.mjs";

const CONFIG = {
  baseUrl: "https://staging.eliza.app",
  callbackUrl: "https://staging.eliza.app/login",
  tenantId: "elizacloud-staging",
};

describe("Steward OAuth callback deployment probe", () => {
  test("proves both provider handoffs use the exact canonical callback", async () => {
    const requested: URL[] = [];
    const results = await verifyStewardOAuthCallbacks(CONFIG, {
      fetchImpl: async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requested.push(url);
        const provider = url.pathname.includes("/discord/")
          ? "discord"
          : "google";
        return new Response(null, {
          status: 302,
          headers: {
            Location:
              provider === "discord"
                ? "https://discord.com/oauth2/authorize?client_id=public"
                : "https://accounts.google.com/o/oauth2/v2/auth?client_id=public",
          },
        });
      },
    });

    expect(results).toEqual([
      { provider: "discord", destinationHostname: "discord.com" },
      { provider: "google", destinationHostname: "accounts.google.com" },
    ]);
    expect(requested).toHaveLength(2);
    for (const url of requested) {
      expect(url.origin).toBe(CONFIG.baseUrl);
      expect(url.searchParams.get("tenant_id")).toBe(CONFIG.tenantId);
      expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.callbackUrl);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    }
  });

  test("fails closed on the tenant's disallowed-redirect response", async () => {
    await expect(
      verifyStewardOAuthCallbacks(CONFIG, {
        fetchImpl: async () =>
          Response.json(
            { ok: false, error: "redirect_uri is not allowed for this tenant" },
            { status: 400 },
          ),
      }),
    ).rejects.toThrow("HTTP 400");
  });

  test("rejects a redirect to a non-provider host", async () => {
    await expect(
      verifyStewardOAuthCallbacks(CONFIG, {
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://attacker.example/collect" },
          }),
      }),
    ).rejects.toThrow("unexpected provider host");
  });

  test("requires HTTPS and all three deployment-owned inputs", () => {
    expect(() =>
      parseStewardCallbackProbeArgs([
        "--base-url",
        "http://staging.eliza.app",
        "--callback-url",
        CONFIG.callbackUrl,
        "--tenant-id",
        CONFIG.tenantId,
      ]),
    ).toThrow("--base-url must use https");
    expect(() => parseStewardCallbackProbeArgs([])).toThrow(
      "--base-url is required",
    );
  });
});
