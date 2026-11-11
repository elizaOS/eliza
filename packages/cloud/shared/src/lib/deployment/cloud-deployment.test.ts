import { describe, expect, test } from "bun:test";
import {
  checkElizaMutatingRequestOrigin,
  isPermittedElizaBrowserOrigin,
} from "../auth/browser-origin-policy";
import { isFirstPartyOrigin } from "../cors/first-party-origin";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import {
  getDefaultPlatformRedirectOrigins,
  isAllowedAbsoluteRedirectUrl,
} from "../security/redirect-validation";
import { publicUrlForR2Key } from "../storage/r2-public-object";
import { getCorsHeaders } from "../utils/cors";
import { getRandomUserAvatar } from "../utils/default-user-avatar";
import {
  CloudDeploymentConfigError,
  getCloudDeployment,
  resolveCloudBlobHost,
  resolveCloudCallbackOrigins,
  resolveCloudDeployment,
} from "./cloud-deployment";

const ALPHA = {
  CLOUD_DEPLOYMENT_ID: "alpha",
  CLOUD_WEB_ORIGIN: "https://alpha.example",
  NEXT_PUBLIC_APP_URL: "https://cloud.alpha.example",
  NEXT_PUBLIC_API_URL: "https://api.alpha.example",
  STEWARD_TENANT_ID: "alphacloud",
  CLOUD_PUBLIC_SERVICE_NAME: "Alpha Cloud",
  R2_PUBLIC_HOST: "blob.alpha.example",
  NEXT_PUBLIC_ASSETS_CDN_URL: "https://assets.alpha.example/static/",
  SENDGRID_FROM_EMAIL: "noreply@alpha.example",
  CLOUD_BILLING_URL: "https://cloud.alpha.example/billing",
  ENVIRONMENT: "production",
} as const;

// Settings whose absence would otherwise leave a process-level value visible.
const CLEARED = {
  NEXT_PUBLIC_STEWARD_TENANT_ID: "",
  SMTP_FROM: "",
  CLOUD_FIRST_PARTY_ORIGINS: "",
};

/** Run `fn` as a Worker request whose bindings describe the Alpha deployment. */
function asAlpha<T>(fn: () => T, overrides: Record<string, string> = {}): T {
  return runWithCloudBindings({ ...CLEARED, ...ALPHA, ...overrides }, fn);
}

/** Run `fn` as a Worker request of the Eliza production deployment. */
function asEliza<T>(fn: () => T): T {
  return runWithCloudBindings(
    {
      ...CLEARED,
      CLOUD_DEPLOYMENT_ID: "",
      CLOUD_WEB_ORIGIN: "",
      NEXT_PUBLIC_APP_URL: "",
      NEXT_PUBLIC_API_URL: "",
      STEWARD_TENANT_ID: "",
      CLOUD_PUBLIC_SERVICE_NAME: "",
      R2_PUBLIC_HOST: "",
      NEXT_PUBLIC_ASSETS_CDN_URL: "",
      SENDGRID_FROM_EMAIL: "",
      CLOUD_BILLING_URL: "",
      ENVIRONMENT: "production",
    },
    fn,
  );
}

const ELIZA_ORIGINS = [
  "https://eliza.app",
  "https://www.eliza.app",
  "https://cloud.eliza.app",
  "https://api.eliza.app",
  "https://staging.eliza.app",
  "https://cloud-staging.eliza.app",
  "https://elizacloud.ai",
  "https://app.elizacloud.ai",
  "https://elizaos.ai",
  "https://eliza.ai",
];

describe("resolveCloudDeployment: Eliza", () => {
  test("an unset deployment id is Eliza with its historical values", () => {
    const eliza = resolveCloudDeployment({});
    expect(eliza).toMatchObject({
      id: "eliza",
      isEliza: true,
      webOrigin: "https://eliza.app",
      appOrigin: "https://cloud.eliza.app",
      apiOrigin: "https://api.eliza.app",
      tenantId: "elizacloud",
      serviceName: "Eliza Cloud",
      blobHost: "blob.eliza.app",
      assetsBase: "https://blob.eliza.app",
      mailFrom: "noreply@eliza.app",
      billingUrl: "https://cloud.eliza.app/cloud/billing",
      speechConsentOrigin: "https://api.eliza.app",
    });
    expect(resolveCloudDeployment({ CLOUD_DEPLOYMENT_ID: "eliza" })).toEqual(eliza);
    expect(resolveCloudDeployment({ CLOUD_DEPLOYMENT_ID: "  " })).toEqual(eliza);
  });

  test("the boundary allowlists are the ones each boundary carried before", () => {
    const eliza = resolveCloudDeployment({});
    expect([...eliza.firstPartyOrigins].sort()).toEqual(
      [
        "https://eliza.app",
        "https://cloud.eliza.app",
        "https://api.eliza.app",
        "https://staging.eliza.app",
        "https://cloud-staging.eliza.app",
        "https://api-staging.eliza.app",
        "https://www.eliza.app",
        "https://elizacloud.ai",
        "https://www.elizacloud.ai",
        "https://dev.elizacloud.ai",
        "https://b.eliza.app",
        "https://eliza-app-b.pages.dev",
        "https://app.elizacloud.ai",
        "https://api.elizacloud.ai",
        "https://staging.elizacloud.ai",
        "https://app-staging.elizacloud.ai",
        "https://api-staging.elizacloud.ai",
        "https://develop.eliza-app.pages.dev",
        "https://staging.eliza-app.pages.dev",
        "https://elizaos.ai",
        "https://www.elizaos.ai",
        "https://os.elizacloud.ai",
        "https://os.eliza.app",
        "https://eliza.ai",
        "https://www.eliza.ai",
      ].sort(),
    );
    expect([...eliza.browserOriginHosts].sort()).toEqual(
      [
        "eliza.app",
        "cloud.eliza.app",
        "staging.eliza.app",
        "cloud-staging.eliza.app",
        "www.eliza.app",
        "elizacloud.ai",
        "www.elizacloud.ai",
        "dev.elizacloud.ai",
        "b.eliza.app",
        "eliza-app-b.pages.dev",
        "app.elizacloud.ai",
        "staging.elizacloud.ai",
        "app-staging.elizacloud.ai",
        "elizaos.ai",
        "www.elizaos.ai",
      ].sort(),
    );
    expect([...eliza.authCorsOrigins].sort()).toEqual(
      [
        "https://eliza.app",
        "https://cloud.eliza.app",
        "https://staging.eliza.app",
        "https://cloud-staging.eliza.app",
        "https://eliza.ai",
        "https://www.eliza.ai",
        "https://elizacloud.ai",
        "https://www.elizacloud.ai",
        "https://app.elizacloud.ai",
        "https://app-staging.elizacloud.ai",
        "https://develop.eliza-app.pages.dev",
        "https://staging.eliza-app.pages.dev",
        "capacitor://localhost",
      ].sort(),
    );
    expect(eliza.platformRedirectOrigins).toEqual([
      "http://localhost:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
      "https://eliza.ai",
      "https://www.eliza.ai",
      "https://eliza.app",
      "https://cloud.eliza.app",
      "https://staging.eliza.app",
      "https://cloud-staging.eliza.app",
    ]);
    expect(eliza.checkoutReturnOrigins).toEqual([
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:4455",
      "https://elizaos.ai",
      "https://www.elizaos.ai",
      "https://os.eliza.app",
      "https://os.elizacloud.ai",
      "https://eliza.ai",
      "https://www.eliza.ai",
    ]);
  });

  test("existing Eliza overrides keep working and keep their precedence", () => {
    const staging = resolveCloudDeployment({
      ENVIRONMENT: "staging",
      NEXT_PUBLIC_APP_URL: "https://cloud-staging.eliza.app",
      NEXT_PUBLIC_API_URL: "https://api-staging.eliza.app",
      STEWARD_TENANT_ID: "ignored",
      NEXT_PUBLIC_STEWARD_TENANT_ID: "elizacloud-staging",
      R2_PUBLIC_HOST: "blob-staging.eliza.app",
      NEXT_PUBLIC_ASSETS_CDN_URL: "https://blob-staging.eliza.app/",
      SMTP_FROM: "smtp@eliza.app",
    });
    expect(staging).toMatchObject({
      id: "eliza",
      webOrigin: "https://staging.eliza.app",
      appOrigin: "https://cloud-staging.eliza.app",
      apiOrigin: "https://api-staging.eliza.app",
      tenantId: "elizacloud-staging",
      blobHost: "blob-staging.eliza.app",
      assetsBase: "https://blob-staging.eliza.app",
      mailFrom: "smtp@eliza.app",
      // Both were production literals on every Eliza environment.
      billingUrl: "https://cloud.eliza.app/cloud/billing",
      speechConsentOrigin: "https://api.eliza.app",
    });
    expect(staging.platformRedirectOrigins[0]).toBe("https://cloud-staging.eliza.app");
    expect(staging.checkoutReturnOrigins[0]).toBe("https://cloud-staging.eliza.app");
    // Unset app URL on staging still meant the production app.
    expect(resolveCloudDeployment({ ENVIRONMENT: "staging" }).appOrigin).toBe(
      "https://cloud.eliza.app",
    );
  });

  test("Eliza policy functions admit Eliza origins and refuse a product's", () => {
    asEliza(() => {
      expect(getCloudDeployment().id).toBe("eliza");
      expect(isFirstPartyOrigin("https://eliza.app")).toBe(true);
      expect(isFirstPartyOrigin("https://api-staging.eliza.app")).toBe(true);
      expect(isFirstPartyOrigin("https://cloud.alpha.example")).toBe(false);
      expect(isPermittedElizaBrowserOrigin("cloud.eliza.app", null, true)).toBe(true);
      expect(isPermittedElizaBrowserOrigin("api.eliza.app", null, true)).toBe(false);
      expect(isPermittedElizaBrowserOrigin("cloud.alpha.example", null, true)).toBe(false);
      expect(getCorsHeaders("https://cloud.eliza.app")["Access-Control-Allow-Origin"]).toBe(
        "https://cloud.eliza.app",
      );
      expect(
        getCorsHeaders("https://cloud.alpha.example")["Access-Control-Allow-Origin"],
      ).toBeUndefined();
      expect(getRandomUserAvatar()).toMatch(
        /^https:\/\/blob\.eliza\.app\/cloud-avatars\/profile-\d+\.webp$/,
      );
      expect(publicUrlForR2Key({ BLOB: undefined as never }, "avatars/a.png")).toBe(
        "https://blob.eliza.app/avatars/a.png",
      );
    });
  });
});

describe("resolveCloudDeployment: product deployment", () => {
  test("a complete configuration resolves to the product's own identity", () => {
    const alpha = resolveCloudDeployment(ALPHA);
    expect(alpha).toMatchObject({
      id: "alpha",
      isEliza: false,
      webOrigin: "https://alpha.example",
      appOrigin: "https://cloud.alpha.example",
      apiOrigin: "https://api.alpha.example",
      tenantId: "alphacloud",
      serviceName: "Alpha Cloud",
      blobHost: "blob.alpha.example",
      assetsBase: "https://assets.alpha.example/static",
      mailFrom: "noreply@alpha.example",
      billingUrl: "https://cloud.alpha.example/billing",
      speechConsentOrigin: "https://api.alpha.example",
    });
    expect([...alpha.firstPartyOrigins].sort()).toEqual([
      "https://alpha.example",
      "https://api.alpha.example",
      "https://cloud.alpha.example",
    ]);
    expect([...alpha.browserOriginHosts].sort()).toEqual(["alpha.example", "cloud.alpha.example"]);
    expect(alpha.platformRedirectOrigins).toEqual([
      "https://alpha.example",
      "https://cloud.alpha.example",
    ]);
    expect(alpha.checkoutReturnOrigins).toEqual(alpha.platformRedirectOrigins);
    const values = Object.values(alpha).map((value) => (value instanceof Set ? [...value] : value));
    expect(JSON.stringify(values)).not.toMatch(/eliza/i);
  });

  test("extra first-party origins are exact origins and join every web policy", () => {
    const alpha = resolveCloudDeployment({
      ...ALPHA,
      CLOUD_FIRST_PARTY_ORIGINS: "https://www.alpha.example, https://store.alpha.example/",
    });
    expect(alpha.firstPartyOrigins.has("https://www.alpha.example")).toBe(true);
    expect(alpha.browserOriginHosts.has("store.alpha.example")).toBe(true);
    expect(alpha.checkoutReturnOrigins).toContain("https://store.alpha.example");
    for (const bad of ["https://*.alpha.example", "http://alpha.example", "alpha.example"]) {
      expect(() => resolveCloudDeployment({ ...ALPHA, CLOUD_FIRST_PARTY_ORIGINS: bad })).toThrow(
        CloudDeploymentConfigError,
      );
    }
  });

  for (const name of [
    "CLOUD_WEB_ORIGIN",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_API_URL",
    "STEWARD_TENANT_ID",
    "CLOUD_PUBLIC_SERVICE_NAME",
    "R2_PUBLIC_HOST",
    "NEXT_PUBLIC_ASSETS_CDN_URL",
    "SENDGRID_FROM_EMAIL",
    "CLOUD_BILLING_URL",
  ] as const) {
    test(`a missing ${name} fails closed and names the setting`, () => {
      for (const absent of [undefined, "", "   "]) {
        let error: unknown;
        try {
          resolveCloudDeployment({ ...ALPHA, [name]: absent });
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(CloudDeploymentConfigError);
        expect((error as CloudDeploymentConfigError).setting).toBe(name);
        expect((error as CloudDeploymentConfigError).deploymentId).toBe("alpha");
        expect((error as Error).message).toContain(name);
        expect((error as Error).message).not.toMatch(/eliza/i);
      }
    });
  }

  test("the alternate tenant and sender settings satisfy the requirement", () => {
    expect(
      resolveCloudDeployment({
        ...ALPHA,
        STEWARD_TENANT_ID: undefined,
        NEXT_PUBLIC_STEWARD_TENANT_ID: "alpha-public",
        SENDGRID_FROM_EMAIL: undefined,
        SMTP_FROM: "Alpha <mail@alpha.example>",
      }),
    ).toMatchObject({ tenantId: "alpha-public", mailFrom: "Alpha <mail@alpha.example>" });
  });

  test("malformed values are refused rather than repaired", () => {
    const invalid: Array<[string, string]> = [
      ["CLOUD_DEPLOYMENT_ID", "Alpha Cloud"],
      ["CLOUD_WEB_ORIGIN", "http://alpha.example"],
      ["CLOUD_WEB_ORIGIN", "https://alpha.example/path"],
      ["NEXT_PUBLIC_APP_URL", "https://user:pw@cloud.alpha.example"],
      ["NEXT_PUBLIC_API_URL", "ftp://api.alpha.example"],
      ["R2_PUBLIC_HOST", "https://blob.alpha.example"],
      ["R2_PUBLIC_HOST", "blob.alpha.example/path"],
      ["NEXT_PUBLIC_ASSETS_CDN_URL", "assets.alpha.example"],
      ["SENDGRID_FROM_EMAIL", "not-an-address"],
      ["CLOUD_BILLING_URL", "/billing"],
    ];
    for (const [name, value] of invalid) {
      let error: unknown;
      try {
        resolveCloudDeployment({ ...ALPHA, [name]: value });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CloudDeploymentConfigError);
      expect((error as CloudDeploymentConfigError).setting).toBe(name);
    }
  });

  test("a loopback deployment may use http", () => {
    expect(
      resolveCloudDeployment({
        ...ALPHA,
        NEXT_PUBLIC_API_URL: "http://127.0.0.1:8787",
      }).apiOrigin,
    ).toBe("http://127.0.0.1:8787");
  });

  test("credentialed CORS admits the product's origins and refuses Eliza's", () => {
    asAlpha(() => {
      for (const origin of [
        "https://alpha.example",
        "https://cloud.alpha.example",
        "https://api.alpha.example",
      ]) {
        expect(isFirstPartyOrigin(origin)).toBe(true);
      }
      for (const origin of [...ELIZA_ORIGINS, "https://evil.alpha.example"]) {
        expect(isFirstPartyOrigin(origin)).toBe(false);
      }
      // Production never reflects loopback, on any deployment.
      expect(isFirstPartyOrigin("http://localhost:3000")).toBe(false);
    });
  });

  test("the CSRF origin check admits the product's hosts and refuses Eliza's", () => {
    const request = (headers: Record<string, string>) => ({
      header: (name: string) => headers[name.toLowerCase()],
    });
    asAlpha(() => {
      expect(isPermittedElizaBrowserOrigin("cloud.alpha.example", null, true)).toBe(true);
      expect(isPermittedElizaBrowserOrigin("alpha.example", null, true)).toBe(true);
      for (const origin of ELIZA_ORIGINS) {
        expect(isPermittedElizaBrowserOrigin(new URL(origin).hostname, null, true)).toBe(false);
      }
      expect(
        checkElizaMutatingRequestOrigin(
          request({ origin: "https://cloud.alpha.example", host: "api.alpha.example" }),
          true,
        ),
      ).toEqual({ ok: true });
      expect(
        checkElizaMutatingRequestOrigin(
          request({ origin: "https://eliza.app", host: "api.alpha.example" }),
          true,
        ).ok,
      ).toBe(false);
      expect(
        checkElizaMutatingRequestOrigin(
          request({ referer: "https://cloud.eliza.app/login", host: "api.alpha.example" }),
          true,
        ).ok,
      ).toBe(false);
    });
  });

  test("auth-route CORS reflects the product's origins and not Eliza's", () => {
    asAlpha(() => {
      expect(getCorsHeaders("https://cloud.alpha.example")).toMatchObject({
        "Access-Control-Allow-Origin": "https://cloud.alpha.example",
        "Access-Control-Allow-Credentials": "true",
      });
      expect(getCorsHeaders("capacitor://localhost")["Access-Control-Allow-Origin"]).toBe(
        "capacitor://localhost",
      );
      for (const origin of ELIZA_ORIGINS) {
        expect(getCorsHeaders(origin)["Access-Control-Allow-Origin"]).toBeUndefined();
      }
    });
  });

  test("redirect validation accepts the product's origins and refuses Eliza's", () => {
    asAlpha(() => {
      const allowed = getDefaultPlatformRedirectOrigins();
      expect(allowed).toEqual(["https://alpha.example", "https://cloud.alpha.example"]);
      expect(isAllowedAbsoluteRedirectUrl("https://cloud.alpha.example/done?x=1", allowed)).toBe(
        true,
      );
      for (const origin of [...ELIZA_ORIGINS, "http://localhost:3000"]) {
        expect(isAllowedAbsoluteRedirectUrl(`${origin}/done`, allowed)).toBe(false);
      }
    });
  });

  test("avatar and blob URLs use the product's hosts", () => {
    asAlpha(() => {
      for (let i = 0; i < 20; i += 1) {
        expect(getRandomUserAvatar()).toMatch(
          /^https:\/\/assets\.alpha\.example\/static\/cloud-avatars\/profile-\d+\.webp$/,
        );
      }
      expect(publicUrlForR2Key({ BLOB: undefined as never }, "avatars/a.png")).toBe(
        "https://blob.alpha.example/avatars/a.png",
      );
    });
  });

  test("an incomplete product deployment fails every boundary instead of using Eliza", () => {
    asAlpha(
      () => {
        expect(() => isFirstPartyOrigin("https://eliza.app")).toThrow(CloudDeploymentConfigError);
        expect(() => isPermittedElizaBrowserOrigin("eliza.app", null, true)).toThrow(
          CloudDeploymentConfigError,
        );
        expect(() => getCorsHeaders("https://eliza.app")).toThrow(CloudDeploymentConfigError);
        expect(() => getDefaultPlatformRedirectOrigins()).toThrow(CloudDeploymentConfigError);
        expect(() => getRandomUserAvatar()).toThrow(CloudDeploymentConfigError);
      },
      { NEXT_PUBLIC_ASSETS_CDN_URL: "" },
    );
  });
});

describe("resolveCloudBlobHost", () => {
  test("an explicit binding wins", () => {
    expect(resolveCloudBlobHost({ R2_PUBLIC_HOST: " blob.example.test " })).toBe(
      "blob.example.test",
    );
  });

  test("only Eliza has a default", () => {
    asEliza(() => {
      expect(resolveCloudBlobHost({})).toBe("blob.eliza.app");
    });
    expect(() => resolveCloudBlobHost({ CLOUD_DEPLOYMENT_ID: "alpha" })).toThrow(
      CloudDeploymentConfigError,
    );
    asAlpha(
      () => {
        let error: unknown;
        try {
          publicUrlForR2Key({ BLOB: undefined as never }, "avatars/a.png");
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(CloudDeploymentConfigError);
        expect((error as CloudDeploymentConfigError).setting).toBe("R2_PUBLIC_HOST");
      },
      { R2_PUBLIC_HOST: "" },
    );
  });
});

describe("resolveCloudCallbackOrigins", () => {
  test("Eliza keeps one contract per environment", () => {
    expect(resolveCloudCallbackOrigins({}, "staging")).toEqual({
      webOrigin: "https://staging.eliza.app",
      appOrigin: "https://cloud-staging.eliza.app",
      apiOrigin: "https://api-staging.eliza.app",
    });
    expect(resolveCloudCallbackOrigins({ CLOUD_DEPLOYMENT_ID: "eliza" }, "production")).toEqual({
      webOrigin: "https://eliza.app",
      appOrigin: "https://cloud.eliza.app",
      apiOrigin: "https://api.eliza.app",
    });
  });

  test("a product uses its own origins and fails closed when incomplete", () => {
    expect(resolveCloudCallbackOrigins(ALPHA, "production")).toEqual({
      webOrigin: "https://alpha.example",
      appOrigin: "https://cloud.alpha.example",
      apiOrigin: "https://api.alpha.example",
    });
    expect(() =>
      resolveCloudCallbackOrigins({ CLOUD_DEPLOYMENT_ID: "alpha" }, "production"),
    ).toThrow(CloudDeploymentConfigError);
  });
});
