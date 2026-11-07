import { describe, expect, test } from "bun:test";
import { spawnSync } from "../../../scripts/lib/spawn-sync-captured.ts";
import { parseProviderDiscoveryArgs } from "../verify-steward-provider-discovery.ts";
import {
  CANONICAL_LOGIN_UPSTREAM_URLS,
  CLOUDFLARE_LOGIN_HOSTS,
  verifyStewardUpstreamBinding,
} from "../verify-steward-upstream-binding.ts";

const staging = "https://eliza-login-staging.square-rain-7251.workers.dev";
const production =
  "https://eliza-login-production.square-rain-7251.workers.dev";
const stagingCanonical = "https://login-staging.eliza.app";
const productionCanonical = "https://login.eliza.app";
const stagingRailway = "https://steward-api-staging.up.railway.app";
const productionRailway = "https://steward-api-production-115d.up.railway.app";
const productionStewardFi = "https://eliza.steward.fi";

describe("Cloudflare login hosts", () => {
  test("the custom domains are the canonical upstreams", () => {
    expect(CANONICAL_LOGIN_UPSTREAM_URLS).toEqual({
      staging: stagingCanonical,
      production: productionCanonical,
    });
  });

  test("wrangler.toml routes match the verifier's hosts", async () => {
    const toml = Bun.TOML.parse(
      await Bun.file(
        new URL("../../../auth/cloudflare/wrangler.toml", import.meta.url),
      ).text(),
    ) as {
      env: Record<
        string,
        { routes?: Array<{ pattern: string; custom_domain?: boolean }> }
      >;
    };
    for (const environment of ["staging", "production"] as const) {
      expect(toml.env[environment].routes).toEqual([
        { pattern: CLOUDFLARE_LOGIN_HOSTS[environment], custom_domain: true },
      ]);
    }
  });
});

describe("Cloudflare-canonical login cutover", () => {
  const ok = { ok: true, preservedExistingBinding: false, error: null };

  test("accepts each environment's canonical custom domain", () => {
    for (const [deployEnvironment, loginApiUrl] of [
      ["staging", stagingCanonical],
      ["production", productionCanonical],
    ]) {
      expect(
        verifyStewardUpstreamBinding({
          deployEnvironment,
          loginApiUrl,
          stewardApiUrl: "",
        }),
      ).toEqual(ok);
      expect(
        verifyStewardUpstreamBinding({
          deployEnvironment,
          loginApiUrl,
          stewardApiUrl: loginApiUrl,
        }),
      ).toEqual(ok);
    }
  });

  test("rejects the other environment's and spoofed custom domains", () => {
    for (const loginApiUrl of [
      productionCanonical,
      `${stagingCanonical}.evil.example`,
      `${stagingCanonical}/`,
      stagingCanonical.replace("https:", "http:"),
    ]) {
      expect(
        verifyStewardUpstreamBinding({
          deployEnvironment: "staging",
          loginApiUrl,
          stewardApiUrl: "",
          allowRailwayTransition: true,
        }).ok,
      ).toBe(false);
    }
    expect(
      verifyStewardUpstreamBinding({
        deployEnvironment: "production",
        loginApiUrl: stagingCanonical,
        stewardApiUrl: "",
        allowRailwayTransition: true,
      }).ok,
    ).toBe(false);
  });

  test("Railway-era LOGIN_API_URL requires the explicit transition opt-in", () => {
    for (const [deployEnvironment, loginApiUrl] of [
      ["staging", stagingRailway],
      ["production", productionRailway],
      ["production", productionStewardFi],
    ]) {
      const refused = verifyStewardUpstreamBinding({
        deployEnvironment,
        loginApiUrl,
        stewardApiUrl: "",
      });
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("ELIZA_LOGIN_ALLOW_RAILWAY_TRANSITION");
      expect(
        verifyStewardUpstreamBinding({
          deployEnvironment,
          loginApiUrl,
          stewardApiUrl: "",
          allowRailwayTransition: true,
        }),
      ).toEqual(ok);
    }
    // The opt-in never admits another environment's Railway upstream.
    expect(
      verifyStewardUpstreamBinding({
        deployEnvironment: "staging",
        loginApiUrl: productionRailway,
        stewardApiUrl: "",
        allowRailwayTransition: true,
      }).ok,
    ).toBe(false);
  });

  test("a legacy STEWARD_API_URL stays valid before cutover but needs the opt-in after", () => {
    for (const [deployEnvironment, legacy, canonical] of [
      ["staging", stagingRailway, stagingCanonical],
      ["production", productionStewardFi, productionCanonical],
    ]) {
      // Pre-cutover: unchanged behavior, so merging cannot break a release.
      expect(
        verifyStewardUpstreamBinding({
          deployEnvironment,
          stewardApiUrl: legacy,
        }),
      ).toEqual(ok);
      const refused = verifyStewardUpstreamBinding({
        deployEnvironment,
        loginApiUrl: canonical,
        stewardApiUrl: legacy,
      });
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("STEWARD_API_URL");
      expect(
        verifyStewardUpstreamBinding({
          deployEnvironment,
          loginApiUrl: canonical,
          stewardApiUrl: legacy,
          allowRailwayTransition: true,
        }),
      ).toEqual(ok);
    }
    // A cross-environment legacy secret fails in every mode.
    for (const allowRailwayTransition of [false, true]) {
      expect(
        verifyStewardUpstreamBinding({
          deployEnvironment: "staging",
          stewardApiUrl: productionStewardFi,
          allowRailwayTransition,
        }).ok,
      ).toBe(false);
    }
  });

  test("the release CLI honours the opt-in and refuses Railway without it", () => {
    const run = (allow: string) =>
      spawnSync(
        process.execPath,
        [
          new URL("../verify-steward-upstream-binding.ts", import.meta.url)
            .pathname,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DEPLOY_ENVIRONMENT: "staging",
            STEWARD_API_URL: "",
            LOGIN_API_URL: stagingRailway,
            LOGIN_ALLOW_RAILWAY_TRANSITION: allow,
          },
        },
      );
    const refused = run("false");
    expect(refused.status).toBe(1);
    expect(refused.stderr).not.toContain(stagingRailway);
    const allowed = run("true");
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain("transition release only");
    expect(allowed.stdout).not.toContain(stagingRailway);
  });
});

describe("login release routing", () => {
  test("accepts environment-owned Cloudflare origins and preserves unset routing", () => {
    for (const [deployEnvironment, loginApiUrl] of [
      ["staging", staging],
      ["production", production],
    ]) {
      expect(
        verifyStewardUpstreamBinding({
          deployEnvironment,
          loginApiUrl,
          stewardApiUrl: "",
        }),
      ).toEqual({ ok: true, preservedExistingBinding: false, error: null });
    }
    expect(
      verifyStewardUpstreamBinding({
        deployEnvironment: "staging",
        stewardApiUrl: "",
      }),
    ).toEqual({ ok: true, preservedExistingBinding: true, error: null });
  });

  test("rejects foreign origins, malformed overrides, and foreign legacy candidates", () => {
    for (const loginApiUrl of [
      production,
      `${staging}.evil.example`,
      `${staging}/`,
      `${staging}?token=private-test-value`,
      staging.replace("https:", "http:"),
      " ",
      ` ${staging}`,
    ]) {
      const result = verifyStewardUpstreamBinding({
        deployEnvironment: "staging",
        loginApiUrl,
        stewardApiUrl: "",
      });
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain("private-test-value");
    }
    expect(
      verifyStewardUpstreamBinding({
        deployEnvironment: "production",
        loginApiUrl: staging,
        stewardApiUrl: "",
      }).ok,
    ).toBe(false);
    expect(
      verifyStewardUpstreamBinding({
        deployEnvironment: "staging",
        loginApiUrl: staging,
        stewardApiUrl: "https://eliza.steward.fi",
      }).ok,
    ).toBe(false);
  });

  test("provider discovery admits the staging custom domain", () => {
    expect(
      parseProviderDiscoveryArgs([
        "--base-url",
        stagingCanonical,
        "--environment",
        "staging",
        "--surface",
        "upstream",
      ]).baseUrl,
    ).toBe(stagingCanonical);
  });

  test("provider discovery admits the staging replacement but no production upstream", () => {
    const args = (baseUrl: string) => [
      "--base-url",
      baseUrl,
      "--environment",
      "staging",
      "--surface",
      "upstream",
    ];
    expect(parseProviderDiscoveryArgs(args(staging)).baseUrl).toBe(staging);
    expect(() => parseProviderDiscoveryArgs(args(production))).toThrow(
      "canonical staging",
    );
    expect(() =>
      parseProviderDiscoveryArgs(args(`${staging}.evil.example`)),
    ).toThrow("canonical staging");
    expect(
      parseProviderDiscoveryArgs(
        args("https://steward-api-staging.up.railway.app"),
      ).baseUrl,
    ).toBe("https://steward-api-staging.up.railway.app");
  });

  test("the release CLI rejects a cross-environment override without disclosing it", () => {
    const candidate = `${production}?private-test-value`;
    const result = spawnSync(
      process.execPath,
      [
        new URL("../verify-steward-upstream-binding.ts", import.meta.url)
          .pathname,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DEPLOY_ENVIRONMENT: "staging",
          STEWARD_API_URL: "",
          LOGIN_API_URL: candidate,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LOGIN_API_URL");
    expect(result.stderr).not.toContain(candidate);
  });
});
