/**
 * Issuer acceptance for the OpenID Connect provider, exercised through the real
 * resolver with literal environment objects. Pure functions, no Worker, no
 * network.
 *
 * Two failures drive these cases. An issuer carrying a PATH produces endpoint
 * URLs that 404, because every path below is root-absolute and concatenated
 * onto the issuer — the document would be wrong in a way only a relying party
 * discovers. And plain `http` has to work on a loopback host or the provider
 * cannot be run locally at all, while the console SPA goes on believing it can.
 *
 * The last block leaves the resolver and reads the two committed deployment
 * files, because the issuer is configured TWICE — once for the Worker and once,
 * under a different name, for the console bundle that has to resume against it —
 * and a resolver test cannot see the half that is missing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  describeOidcConfigFailure,
  isIssuerHost,
  isLoopbackIssuerHostname,
  isOidcEnabled,
  type OidcConfigEnv,
  resolveOidcConfig,
  validateOidcIssuer,
} from "./config";

function env(overrides: Partial<OidcConfigEnv> = {}): OidcConfigEnv {
  return { OIDC_ENABLED: "true", OIDC_ISSUER_URL: "https://api.elizacloud.ai", ...overrides };
}

describe("the kill switch", () => {
  test('is off unless the value is exactly "true"', () => {
    for (const value of ["false", "1", "TRUE", " ", undefined, true]) {
      expect(isOidcEnabled({ OIDC_ENABLED: value })).toBe(false);
    }
    expect(isOidcEnabled({ OIDC_ENABLED: "true" })).toBe(true);
  });

  test("resolves nothing while disabled, whatever the issuer says", () => {
    expect(resolveOidcConfig(env({ OIDC_ENABLED: "false" }))).toBeNull();
    expect(describeOidcConfigFailure(env({ OIDC_ENABLED: "false" }))).toMatch(/OIDC_ENABLED/);
  });
});

describe("endpoint derivation", () => {
  test("every URL hangs off the issuer, which keeps its bytes", () => {
    const config = resolveOidcConfig(env());
    expect(config).not.toBeNull();
    expect(config?.issuer).toBe("https://api.elizacloud.ai");
    expect(config?.discoveryUrl).toBe("https://api.elizacloud.ai/.well-known/openid-configuration");
    expect(config?.jwksUrl).toBe("https://api.elizacloud.ai/.well-known/oidc/jwks.json");
    expect(config?.authorizationUrl).toBe("https://api.elizacloud.ai/api/oidc/authorize");
    expect(config?.resumeUrl).toBe("https://api.elizacloud.ai/api/oidc/authorize/resume");
    expect(config?.tokenUrl).toBe("https://api.elizacloud.ai/api/oidc/token");
    expect(config?.userinfoUrl).toBe("https://api.elizacloud.ai/api/oidc/userinfo");
  });

  test("a trailing slash is dropped so the issuer an RP pins never doubles it", () => {
    const config = resolveOidcConfig(env({ OIDC_ISSUER_URL: "https://api.elizacloud.ai/" }));
    expect(config?.issuer).toBe("https://api.elizacloud.ai");
    expect(config?.discoveryUrl).toBe("https://api.elizacloud.ai/.well-known/openid-configuration");
  });

  test("the app origin comes from the console URL, falling back to the issuer origin", () => {
    expect(resolveOidcConfig(env({ ELIZA_CLOUD_URL: "https://elizacloud.ai/" }))?.appOrigin).toBe(
      "https://elizacloud.ai",
    );
    expect(resolveOidcConfig(env())?.appOrigin).toBe("https://api.elizacloud.ai");
  });
});

describe("an issuer with a path", () => {
  test("is refused rather than producing endpoint URLs that drop it", () => {
    // `https://api.example/oidc` + `/api/oidc/token` is `https://api.example/api/oidc/token`:
    // the path silently disappears from every advertised URL.
    for (const issuer of [
      "https://api.elizacloud.ai/oidc",
      "https://api.elizacloud.ai/oidc/",
      "https://elizacloud.ai/auth/realms/eliza",
    ]) {
      const checked = validateOidcIssuer(issuer);
      expect(checked.ok).toBe(false);
      expect(resolveOidcConfig(env({ OIDC_ISSUER_URL: issuer }))).toBeNull();
      expect(describeOidcConfigFailure(env({ OIDC_ISSUER_URL: issuer }))).toMatch(
        /must be an origin with no path/,
      );
    }
  });

  test("a bare origin, with or without the root slash, is accepted", () => {
    expect(validateOidcIssuer("https://api.elizacloud.ai").ok).toBe(true);
    expect(validateOidcIssuer("https://api.elizacloud.ai/").ok).toBe(true);
  });
});

describe("loopback development", () => {
  test("http works on the loopback names a browser actually reaches", () => {
    for (const issuer of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const config = resolveOidcConfig(env({ OIDC_ISSUER_URL: issuer }));
      expect(config?.issuer).toBe(issuer);
      expect(config?.tokenUrl).toBe(`${issuer}/api/oidc/token`);
      expect(describeOidcConfigFailure(env({ OIDC_ISSUER_URL: issuer }))).toBe("");
    }
    expect(isLoopbackIssuerHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackIssuerHostname("LOCALHOST")).toBe(true);
  });

  test("the request host is matched with its port, so 5173 is not 8787", () => {
    const config = resolveOidcConfig(env({ OIDC_ISSUER_URL: "http://127.0.0.1:8787" }));
    expect(config).not.toBeNull();
    expect(isIssuerHost("http://127.0.0.1:8787/api/oidc/token", config as never)).toBe(true);
    expect(isIssuerHost("http://127.0.0.1:5173/api/oidc/token", config as never)).toBe(false);
    // Different loopback NAMES are different cookie jars as well as different
    // hosts; the provider must not answer for one while named the other.
    expect(isIssuerHost("http://localhost:8787/api/oidc/token", config as never)).toBe(false);
  });

  test("http anywhere else is refused, and says which hosts are allowed", () => {
    for (const issuer of ["http://api.elizacloud.ai", "http://0.0.0.0:8787", "http://hub.local"]) {
      expect(resolveOidcConfig(env({ OIDC_ISSUER_URL: issuer }))).toBeNull();
      expect(describeOidcConfigFailure(env({ OIDC_ISSUER_URL: issuer }))).toMatch(/127\.0\.0\.1/);
    }
  });
});

describe("issuers that cannot be served at all", () => {
  test("a missing, unparseable, or non-HTTP issuer names the variable", () => {
    expect(describeOidcConfigFailure(env({ OIDC_ISSUER_URL: undefined }))).toMatch(
      /OIDC_ISSUER_URL is not set/,
    );
    for (const issuer of ["not a url", "api.elizacloud.ai", "ftp://api.elizacloud.ai"]) {
      expect(resolveOidcConfig(env({ OIDC_ISSUER_URL: issuer }))).toBeNull();
      expect(describeOidcConfigFailure(env({ OIDC_ISSUER_URL: issuer }))).toContain(
        "OIDC_ISSUER_URL",
      );
    }
  });

  test("a query, fragment, or embedded credential is refused", () => {
    for (const issuer of [
      "https://api.elizacloud.ai/?x=1",
      "https://api.elizacloud.ai/#f",
      "https://user:pass@api.elizacloud.ai",
    ]) {
      expect(resolveOidcConfig(env({ OIDC_ISSUER_URL: issuer }))).toBeNull();
      expect(describeOidcConfigFailure(env({ OIDC_ISSUER_URL: issuer })).length).toBeGreaterThan(0);
    }
  });
});

/**
 * The console half of the issuer. `/oidc/continue` — the leg EVERY first-time
 * relying-party user takes, because it is the signed-out path — resolves the
 * resume URL from the build-time `VITE_OIDC_ISSUER_URL`, and Vite inlines that
 * from the process environment of the `build:web` step. A console built without
 * it reaches the page and dead-ends there, which nothing else in this repository
 * observes: the Worker is configured correctly and reports itself healthy.
 */
describe("the console bundle is built with the issuer the Worker serves", () => {
  const repoRoot = join(import.meta.dir, "../../../../../..");
  const wrangler = readFileSync(join(repoRoot, "packages/cloud/api/wrangler.toml"), "utf8");
  const workflow = readFileSync(join(repoRoot, ".github/workflows/cloud-cf-deploy.yml"), "utf8");

  /** Every `NAME = "value"` / `NAME: …'value'…` URL literal for one variable. */
  function configuredUrls(source: string, name: string): string[] {
    const found = new Set<string>();
    for (const line of source.split("\n")) {
      if (!new RegExp(`(^|\\s)${name}\\s*[:=]`).test(line)) continue;
      for (const match of line.matchAll(/https?:\/\/[^'"\s]+/g)) found.add(match[0]);
    }
    return [...found].sort();
  }

  const workerIssuers = configuredUrls(wrangler, "OIDC_ISSUER_URL");

  test("the Worker declares one issuer per deployed environment", () => {
    expect(workerIssuers.length).toBeGreaterThan(0);
    for (const issuer of workerIssuers) {
      const checked = validateOidcIssuer(issuer);
      expect(checked.ok).toBe(true);
      expect(resolveOidcConfig(env({ OIDC_ISSUER_URL: issuer }))?.issuer).toBe(issuer);
    }
  });

  test("every console build that pins the API origin also pins the issuer", () => {
    // Both are per-environment absolute origins baked into the same bundle, so
    // a build step carrying one and not the other is the exact shape of the
    // deployment that dead-ends at /oidc/continue.
    const apiSites = workflow.match(/^\s*VITE_API_URL:/gm) ?? [];
    const issuerSites = workflow.match(/^\s*VITE_OIDC_ISSUER_URL:/gm) ?? [];
    expect(apiSites.length).toBeGreaterThan(0);
    expect(issuerSites.length).toBe(apiSites.length);
  });

  test("the console is built with exactly the strings the Worker emits as `iss`", () => {
    // A relying party hard-fails unless the discovery document's `issuer`
    // byte-equals what it was configured with, and the provider answers only on
    // the host its own issuer names — so a console pointed one character off
    // resumes against a host that never heard of its parked request.
    expect(configuredUrls(workflow, "VITE_OIDC_ISSUER_URL")).toEqual(workerIssuers);
  });
});
