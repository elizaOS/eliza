/**
 * Steward canonical sign-in deploy probe tests use deterministic fetch fakes;
 * no provider request or tenant mutation leaves the process.
 */

import { describe, expect, test } from "bun:test";
import {
  main,
  parseStewardCallbackProbeArgs,
  verifyStewardOAuthCallbacks,
  verifyStewardWalletOrigin,
} from "../verify-steward-oauth-callbacks.mjs";

const CONFIG = {
  baseUrl: "https://staging.eliza.app",
  callbackUrl: "https://staging.eliza.app/login",
  tenantId: "elizacloud-staging",
};

function providerDestination(provider: "discord" | "google"): string {
  const destination = new URL(
    provider === "discord"
      ? "https://discord.com/oauth2/authorize"
      : "https://accounts.google.com/o/oauth2/v2/auth",
  );
  destination.searchParams.set("client_id", "public");
  destination.searchParams.set(
    "redirect_uri",
    `${CONFIG.baseUrl}/steward/auth/oauth/${provider}/callback`,
  );
  return destination.toString();
}

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
            Location: providerDestination(provider),
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

  test("rejects an upstream callback bound to another environment", async () => {
    await expect(
      verifyStewardOAuthCallbacks(CONFIG, {
        fetchImpl: async (input: string | URL | Request) => {
          const provider = String(input).includes("/discord/")
            ? "discord"
            : "google";
          const destination = new URL(providerDestination(provider));
          destination.searchParams.set(
            "redirect_uri",
            `https://api.eliza.app/steward/auth/oauth/${provider}/callback`,
          );
          return new Response(null, {
            status: 302,
            headers: { Location: destination.toString() },
          });
        },
      }),
    ).rejects.toThrow(
      "expected https://staging.eliza.app/steward/auth/oauth/discord/callback",
    );
  });

  test("rejects a provider redirect with no callback URI", async () => {
    await expect(
      verifyStewardOAuthCallbacks(CONFIG, {
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://discord.com/oauth2/authorize" },
          }),
      }),
    ).rejects.toThrow("used no redirect_uri");
  });

  test("preserves the established production direct-callback contract", async () => {
    const productionConfig = {
      baseUrl: "https://api.eliza.app",
      callbackUrl: "https://eliza.app/login",
      tenantId: "elizacloud",
    };
    const results = await verifyStewardOAuthCallbacks(productionConfig, {
      fetchImpl: async (input: string | URL | Request) => {
        const provider = String(input).includes("/discord/")
          ? "discord"
          : "google";
        const destination = new URL(providerDestination(provider));
        destination.searchParams.set(
          "redirect_uri",
          `https://eliza.steward.fi/auth/oauth/${provider}/callback`,
        );
        return new Response(null, {
          status: 302,
          headers: { Location: destination.toString() },
        });
      },
    });

    expect(results).toEqual([
      { provider: "discord", destinationHostname: "discord.com" },
      { provider: "google", destinationHostname: "accounts.google.com" },
    ]);
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

describe("Steward wallet-origin deployment probe", () => {
  test("exercises the real same-origin no-Origin proxy path and accepts a nonce", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const result = await verifyStewardWalletOrigin(CONFIG, {
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(input);
        requestedInit = init;
        return Response.json({ nonce: "Tk9iR2buAPsSuxF0T" });
      },
    });

    expect(result).toEqual({ origin: CONFIG.baseUrl });
    expect(requestedUrl).toBe(`${CONFIG.baseUrl}/steward/auth/nonce`);
    expect(requestedInit).toEqual({
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
  });

  test("fails closed when Steward rejects the canonical Origin", async () => {
    await expect(
      verifyStewardWalletOrigin(CONFIG, {
        fetchImpl: async () =>
          Response.json(
            {
              ok: false,
              error: "SIWE nonce requests require an allowed Origin or Referer",
            },
            { status: 400 },
          ),
      }),
    ).rejects.toThrow("wallet origin probe returned HTTP 400");
  });

  test("fails closed on a malformed success response", async () => {
    await expect(
      verifyStewardWalletOrigin(CONFIG, {
        fetchImpl: async () => Response.json({ ok: true }),
      }),
    ).rejects.toThrow("wallet origin probe returned an invalid nonce");
  });

  test.each(["", "   ", "a", "bad!nonce", "seven77"])(
    "rejects unusable nonce %j",
    async (nonce) => {
      await expect(
        verifyStewardWalletOrigin(CONFIG, {
          fetchImpl: async () => Response.json({ nonce }),
        }),
      ).rejects.toThrow("wallet origin probe returned an invalid nonce");
    },
  );

  test("fails closed on invalid JSON", async () => {
    await expect(
      verifyStewardWalletOrigin(CONFIG, {
        fetchImpl: async () =>
          new Response("not-json", {
            headers: { "Content-Type": "application/json" },
          }),
      }),
    ).rejects.toThrow("wallet origin probe returned invalid JSON");
  });

  test("does not follow a redirect away from the canonical browser host", async () => {
    await expect(
      verifyStewardWalletOrigin(CONFIG, {
        fetchImpl: async (_input, init) => {
          expect(init?.redirect).toBe("manual");
          return new Response(null, {
            status: 302,
            headers: { Location: "https://attacker.example/nonce" },
          });
        },
      }),
    ).rejects.toThrow("wallet origin probe returned HTTP 302");
  });
});

describe("Steward deployment probe CLI composition", () => {
  const ARGS = [
    "--base-url",
    CONFIG.baseUrl,
    "--callback-url",
    CONFIG.callbackUrl,
    "--tenant-id",
    CONFIG.tenantId,
  ];

  test("runs both OAuth providers and the wallet leg", async () => {
    const requested: string[] = [];
    const logs: string[] = [];
    await main(ARGS, {
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/steward/auth/nonce")) {
          return Response.json({ nonce: "Tk9iR2buAPsSuxF0T" });
        }
        const destination = providerDestination(
          url.includes("/discord/") ? "discord" : "google",
        );
        return new Response(null, {
          status: 302,
          headers: { Location: destination },
        });
      },
      log: (message: string) => logs.push(message),
    });

    expect(requested).toHaveLength(3);
    expect(requested.at(-1)).toBe(`${CONFIG.baseUrl}/steward/auth/nonce`);
    expect(logs).toEqual([
      "Verified discord canonical callback via discord.com.",
      "Verified google canonical callback via accounts.google.com.",
      `Verified canonical wallet origin ${CONFIG.baseUrl}.`,
    ]);
  });

  test("fails the composed command when the wallet leg is rejected", async () => {
    await expect(
      main(ARGS, {
        fetchImpl: async (input: string | URL | Request) => {
          const url = String(input);
          if (url.endsWith("/steward/auth/nonce")) {
            return Response.json({ error: "origin rejected" }, { status: 400 });
          }
          const destination = providerDestination(
            url.includes("/discord/") ? "discord" : "google",
          );
          return new Response(null, {
            status: 302,
            headers: { Location: destination },
          });
        },
        log: () => undefined,
      }),
    ).rejects.toThrow("wallet origin probe returned HTTP 400");
  });
});
