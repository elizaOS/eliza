/**
 * Unit coverage for the white-label application configuration surface in
 * app-config.ts: the framework default AppConfig and the three-layer
 * resolveAppBranding merge (framework branding defaults, app identity
 * fields, app branding overrides) that every white-label consumer relies
 * on for naming, links, and distribution tokens.
 *
 * Deterministic suite over the real module — no mocks, no network.
 */
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./app-config.ts";
import { DEFAULT_APP_CONFIG, resolveAppBranding } from "./app-config.ts";
import { DEFAULT_BRANDING } from "./branding.ts";

function acmeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    appName: "Acme",
    appId: "com.acme.acme",
    orgName: "acme",
    repoName: "acme-app",
    cliName: "acme",
    description: "Agents for the Acme org",
    branding: {},
    ...overrides,
  };
}

describe("resolveAppBranding", () => {
  it("fills every required branding token from framework defaults when the app declares none", () => {
    const branding = resolveAppBranding(acmeConfig());

    expect(branding.docsUrl).toBe(DEFAULT_BRANDING.docsUrl);
    expect(branding.appUrl).toBe(DEFAULT_BRANDING.appUrl);
    expect(branding.bugReportUrl).toBe(DEFAULT_BRANDING.bugReportUrl);
    expect(branding.hashtag).toBe(DEFAULT_BRANDING.hashtag);
    expect(branding.fileExtension).toBe(DEFAULT_BRANDING.fileExtension);
    expect(branding.packageScope).toBe(DEFAULT_BRANDING.packageScope);
  });

  it("keeps the framework link defaults live and absolute", () => {
    const branding = resolveAppBranding(acmeConfig());

    expect(typeof branding.docsUrl).toBe("string");
    expect(typeof branding.appUrl).toBe("string");
    expect(branding.docsUrl.startsWith("https://")).toBe(true);
    expect(branding.appUrl.startsWith("https://")).toBe(true);
  });

  it("projects the app identity fields onto the resolved branding", () => {
    const branding = resolveAppBranding(acmeConfig());

    expect(branding.appName).toBe("Acme");
    expect(branding.orgName).toBe("acme");
    expect(branding.repoName).toBe("acme-app");
  });

  it("lets the branding block win over the app identity fields", () => {
    const branding = resolveAppBranding(
      acmeConfig({
        appName: "Acme",
        orgName: "acme",
        repoName: "acme-app",
        branding: {
          appName: "AcmeOS",
          orgName: "acme-industries",
          repoName: "acme-monorepo",
        },
      }),
    );

    expect(branding.appName).toBe("AcmeOS");
    expect(branding.orgName).toBe("acme-industries");
    expect(branding.repoName).toBe("acme-monorepo");
  });

  it("preserves untouched defaults alongside a partial branding override", () => {
    const branding = resolveAppBranding(
      acmeConfig({ branding: { cloudOnly: true } }),
    );

    expect(branding.cloudOnly).toBe(true);
    expect(branding.docsUrl).toBe(DEFAULT_BRANDING.docsUrl);
    expect(branding.appUrl).toBe(DEFAULT_BRANDING.appUrl);
    expect(branding.hashtag).toBe(DEFAULT_BRANDING.hashtag);
    expect(branding.fileExtension).toBe(DEFAULT_BRANDING.fileExtension);
  });

  it("replaces individual link defaults without disturbing siblings", () => {
    const branding = resolveAppBranding(
      acmeConfig({
        branding: {
          docsUrl: "https://docs.acme.dev",
          bugReportUrl: "https://github.com/acme/acme-app/issues/new",
        },
      }),
    );

    expect(branding.docsUrl).toBe("https://docs.acme.dev");
    expect(branding.bugReportUrl).toBe(
      "https://github.com/acme/acme-app/issues/new",
    );
    expect(branding.appUrl).toBe(DEFAULT_BRANDING.appUrl);
  });

  it("passes custom provider options through to the resolved branding", () => {
    const providers = [
      {
        id: "acme-cloud",
        name: "Acme Cloud",
        envKey: "ACME_API_KEY",
        pluginName: "@acme/plugin-acme-cloud",
        keyPrefix: null,
        description: "Acme hosted models",
        family: "openai",
        authMode: "api-key" as const,
        group: "cloud" as const,
        order: 1,
      },
    ];

    const branding = resolveAppBranding(
      acmeConfig({ branding: { customProviders: providers } }),
    );

    expect(branding.customProviders).toStrictEqual(providers);
  });

  it("does not mutate the supplied configuration or branding block", () => {
    const config = acmeConfig();
    const frozenBranding = Object.freeze({
      ...config.branding,
      hashtag: "#FrozenAcme",
    }) as Partial<AppConfig["branding"]>;
    const subject = { ...config, branding: frozenBranding };

    const branding = resolveAppBranding(subject);

    expect(branding.hashtag).toBe("#FrozenAcme");
    expect(subject.branding).toStrictEqual(frozenBranding);
  });
});

describe("DEFAULT_APP_CONFIG", () => {
  it("resolves to a complete branding whose identity matches the default app", () => {
    const branding = resolveAppBranding(DEFAULT_APP_CONFIG);

    expect(branding.appName).toBe(DEFAULT_APP_CONFIG.appName);
    expect(branding.orgName).toBe(DEFAULT_APP_CONFIG.orgName);
    expect(branding.repoName).toBe(DEFAULT_APP_CONFIG.repoName);
    expect(branding.customProviders).toBeUndefined();
    expect(branding.cloudOnly).toBeUndefined();
  });

  it("applies the default branding block over the framework tokens", () => {
    const branding = resolveAppBranding(DEFAULT_APP_CONFIG);

    expect(branding.bugReportUrl).toBe(
      "https://github.com/elizaOS/eliza/issues/new",
    );
    expect(branding.bugReportUrl).not.toBe(DEFAULT_BRANDING.bugReportUrl);
    expect(branding.hashtag).toBe("#elizaOS");
    expect(branding.hashtag).not.toBe(DEFAULT_BRANDING.hashtag);
  });

  it("keeps the framework documentation and app origins for the default app", () => {
    const branding = resolveAppBranding(DEFAULT_APP_CONFIG);

    expect(branding.docsUrl).toBe(DEFAULT_BRANDING.docsUrl);
    expect(branding.appUrl).toBe(DEFAULT_BRANDING.appUrl);
  });
});
