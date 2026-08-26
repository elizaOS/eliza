/**
 * Locks local development to a coherent Cloud environment so the API and
 * renderer cannot silently split between staging and production.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyDevCloudTarget,
  configureDevCloudEnvironment,
  resolveDevCloudTarget,
} from "./dev-cloud-target.mjs";

const STAGING_ENV = {
  ELIZA_DEV_SOURCE: "1",
  ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
  VITE_ELIZA_CLOUD_BASE: "https://cloud-staging.eliza.app",
  VITE_ELIZA_DESKTOP_RUNTIME_MODE: "cloud",
  VITE_STEWARD_API_URL: "https://staging.eliza.app/steward",
  VITE_STEWARD_TENANT_ID: "elizacloud-staging",
};

const PRODUCTION_ENV = {
  ELIZA_DEV_SOURCE: "1",
  ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
  VITE_ELIZA_CLOUD_BASE: "https://cloud.eliza.app",
  VITE_ELIZA_DESKTOP_RUNTIME_MODE: "cloud",
  VITE_STEWARD_API_URL: "https://eliza.app/steward",
  VITE_STEWARD_TENANT_ID: "elizacloud",
};

describe("local development Cloud target", () => {
  it("defaults ordinary local development to the complete staging tuple", () => {
    const configured = configureDevCloudEnvironment([], {});

    expect(configured.target).toBe("staging");
    expect(configured.effectiveTarget).toBe("staging");
    expect(configured.passthroughArgs).toEqual([]);
    expect(configured.env).toMatchObject(STAGING_ENV);
    for (const key of [
      "ELIZA_DEV_CLOUD_API_KEY",
      "ELIZAOS_CLOUD_API_KEY",
      "ELIZAOS_CLOUD_ENABLED",
      "ELIZA_CLOUD_API_KEY",
      "ELIZACLOUD_API_KEY",
      "ELIZA_CLOUD_PROVISIONED",
    ]) {
      expect(configured.env[key]).toBe("");
    }
  });

  it("selects the complete production tuple explicitly", () => {
    const configured = configureDevCloudEnvironment([], {
      ELIZA_DEV_CLOUD_TARGET: "production",
    });

    expect(configured.target).toBe("production");
    expect(configured.effectiveTarget).toBe("production");
    expect(configured.env).toMatchObject({
      ...PRODUCTION_ENV,
      ELIZA_DEV_CLOUD_TARGET: "production",
    });
    expect(configured.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
  });

  it("masks inherited Cloud activation only for implicit staging", () => {
    const inherited = {
      ELIZA_DEV_CLOUD_API_KEY: "promoted-dev-key",
      ELIZAOS_CLOUD_API_KEY: "generic-key",
      ELIZAOS_CLOUD_ENABLED: "true",
      ELIZA_CLOUD_API_KEY: "legacy-key",
      ELIZACLOUD_API_KEY: "older-key",
      ELIZA_CLOUD_PROVISIONED: "1",
    };

    const implicit = configureDevCloudEnvironment([], inherited);
    for (const key of Object.keys(inherited)) {
      expect(implicit.env[key]).toBe("");
    }

    const explicitStaging = configureDevCloudEnvironment([], {
      ...inherited,
      ELIZA_DEV_CLOUD_TARGET: "staging",
    });
    expect(explicitStaging.env).toMatchObject(inherited);

    const explicitProduction = configureDevCloudEnvironment([], {
      ...inherited,
      ELIZA_DEV_CLOUD_TARGET: "production",
    });
    expect(explicitProduction.env).toMatchObject(inherited);
  });

  it("lets the CLI target override the environment and strips helper flags", () => {
    const args = ["--cloud-target", "production", "--ui-only", "--port=2200"];
    const env = { ELIZA_DEV_CLOUD_TARGET: "staging" };

    expect(resolveDevCloudTarget(args, env)).toEqual({
      target: "production",
      source: "cli",
      passthroughArgs: ["--ui-only", "--port=2200"],
    });
    expect(configureDevCloudEnvironment(args, env).env).toMatchObject({
      ...PRODUCTION_ENV,
      ELIZA_DEV_CLOUD_TARGET: "production",
    });
  });

  it("keeps local-first development off the Cloud plugin and pins manual Cloud to staging", () => {
    const input = {
      ...STAGING_ENV,
      ELIZA_DEV_CLOUD_TARGET: "offline",
      ELIZA_DEV_CLOUD_API_KEY: "promoted-key-must-not-reach-local-agent",
      ELIZAOS_CLOUD_API_KEY: "production-key-must-not-reach-local-agent",
      ELIZAOS_CLOUD_ENABLED: "true",
      ELIZA_CLOUD_API_KEY: "legacy-key-must-not-reach-local-agent",
      ELIZACLOUD_API_KEY: "older-key-must-not-reach-local-agent",
      ELIZA_CLOUD_PROVISIONED: "1",
      PRESERVED_LOCAL_SETTING: "yes",
    };
    const configured = configureDevCloudEnvironment([], input);

    expect(configured.target).toBe("offline");
    expect(configured.effectiveTarget).toBe("offline");
    expect(configured.env).toMatchObject({
      ELIZA_DEV_SOURCE: "1",
      ELIZA_DEV_CLOUD_TARGET: "offline",
      ELIZAOS_CLOUD_BASE_URL: STAGING_ENV.ELIZAOS_CLOUD_BASE_URL,
      VITE_ELIZA_CLOUD_BASE: STAGING_ENV.VITE_ELIZA_CLOUD_BASE,
      VITE_STEWARD_API_URL: STAGING_ENV.VITE_STEWARD_API_URL,
      VITE_STEWARD_TENANT_ID: STAGING_ENV.VITE_STEWARD_TENANT_ID,
      VITE_ELIZA_ENABLE_RUNTIME_CHOOSER: "1",
      PRESERVED_LOCAL_SETTING: "yes",
    });
    for (const key of [
      "ELIZA_DEV_CLOUD_API_KEY",
      "ELIZAOS_CLOUD_API_KEY",
      "ELIZAOS_CLOUD_ENABLED",
      "ELIZA_CLOUD_API_KEY",
      "ELIZACLOUD_API_KEY",
      "ELIZA_CLOUD_PROVISIONED",
      "VITE_ELIZA_DESKTOP_RUNTIME_MODE",
    ]) {
      expect(configured.env[key]).toBe("");
    }
  });

  it("preserves a coherent custom/self-hosted tuple without mutating input", () => {
    const input = {
      ELIZAOS_CLOUD_BASE_URL: "https://api.private.example",
      VITE_ELIZA_CLOUD_BASE: "https://api.private.example",
      VITE_ELIZA_DESKTOP_RUNTIME_MODE: "cloud",
      VITE_STEWARD_API_URL: "https://auth.private.example/steward",
      VITE_STEWARD_TENANT_ID: "private-tenant",
      ELIZA_DEV_CLOUD_API_KEY: "private-dev-key",
      CUSTOM_SENTINEL: "keep-me",
    };
    const snapshot = { ...input };
    const configured = configureDevCloudEnvironment([], input);

    expect(configured.target).toBe("staging");
    expect(configured.effectiveTarget).toBe("self-hosted");
    expect(configured.env).toMatchObject({
      ...input,
      ELIZA_DEV_SOURCE: "1",
    });
    expect(input).toEqual(snapshot);
    expect(configured.env).not.toBe(input);
  });

  it("allows an optional /api/v1 suffix for one self-hosted surface", () => {
    const configured = configureDevCloudEnvironment([], {
      ELIZAOS_CLOUD_BASE_URL: "https://private.example/api/v1/",
      VITE_ELIZA_CLOUD_BASE: "https://private.example/",
    });

    expect(configured.effectiveTarget).toBe("self-hosted");
    expect(configured.env).toMatchObject({
      ELIZAOS_CLOUD_BASE_URL: "https://private.example/api/v1/",
      VITE_ELIZA_CLOUD_BASE: "https://private.example/",
      VITE_ELIZA_DESKTOP_RUNTIME_MODE: "cloud",
    });
    expect(configured.env.VITE_STEWARD_API_URL).toBeUndefined();
    expect(configured.env.VITE_STEWARD_TENANT_ID).toBeUndefined();
  });

  it("preserves independently optional self-hosted Steward overrides", () => {
    const withApiUrl = configureDevCloudEnvironment([], {
      ELIZAOS_CLOUD_BASE_URL: "https://private.example",
      VITE_ELIZA_CLOUD_BASE: "https://private.example",
      VITE_STEWARD_API_URL: "https://identity.private.example/steward",
    });
    const withTenant = configureDevCloudEnvironment([], {
      ELIZAOS_CLOUD_BASE_URL: "https://private.example",
      VITE_ELIZA_CLOUD_BASE: "https://private.example",
      VITE_STEWARD_TENANT_ID: "private-tenant",
    });

    expect(withApiUrl.env.VITE_STEWARD_API_URL).toBe(
      "https://identity.private.example/steward",
    );
    expect(withApiUrl.env.VITE_STEWARD_TENANT_ID).toBeUndefined();
    expect(withTenant.env.VITE_STEWARD_API_URL).toBeUndefined();
    expect(withTenant.env.VITE_STEWARD_TENANT_ID).toBe("private-tenant");
  });

  it.each([
    ["not-a-url", "not-a-url"],
    ["ftp://private.example", "ftp://private.example"],
  ])("rejects malformed or non-HTTP self-hosted bases: %s", (api, renderer) => {
    expect(() =>
      configureDevCloudEnvironment([], {
        ELIZAOS_CLOUD_BASE_URL: api,
        VITE_ELIZA_CLOUD_BASE: renderer,
      }),
    ).toThrow(/absolute HTTP\(S\)|use HTTP\(S\)/i);
  });

  it("rejects a one-sided self-hosted base", () => {
    expect(() =>
      configureDevCloudEnvironment([], {
        VITE_ELIZA_CLOUD_BASE: "https://private.example",
      }),
    ).toThrow(/must set both/i);
  });

  it("rejects mismatched self-hosted API and renderer endpoints", () => {
    expect(() =>
      configureDevCloudEnvironment([], {
        ELIZAOS_CLOUD_BASE_URL: "https://api.private.example/api/v1",
        VITE_ELIZA_CLOUD_BASE: "https://app.private.example",
      }),
    ).toThrow(/same Cloud endpoint/i);
  });

  it("lets local-first override inherited self-hosted values with safe staging endpoints", () => {
    const configured = configureDevCloudEnvironment(
      ["--cloud-target=offline"],
      {
        ELIZAOS_CLOUD_BASE_URL: "https://private.example/api/v1",
        VITE_ELIZA_CLOUD_BASE: "https://private.example",
        VITE_STEWARD_API_URL: "https://identity.private.example/steward",
        VITE_STEWARD_TENANT_ID: "private-tenant",
        VITE_ELIZA_DESKTOP_RUNTIME_MODE: "cloud",
      },
    );

    expect(configured.effectiveTarget).toBe("offline");
    expect(configured.env).toMatchObject({
      ELIZAOS_CLOUD_BASE_URL: STAGING_ENV.ELIZAOS_CLOUD_BASE_URL,
      VITE_ELIZA_CLOUD_BASE: STAGING_ENV.VITE_ELIZA_CLOUD_BASE,
      VITE_STEWARD_API_URL: STAGING_ENV.VITE_STEWARD_API_URL,
      VITE_STEWARD_TENANT_ID: STAGING_ENV.VITE_STEWARD_TENANT_ID,
      VITE_ELIZA_DESKTOP_RUNTIME_MODE: "",
      VITE_ELIZA_ENABLE_RUNTIME_CHOOSER: "1",
    });
  });

  it("rejects a canonical override that conflicts with the selected target", () => {
    expect(() =>
      configureDevCloudEnvironment(["--cloud-target=staging"], {
        VITE_ELIZA_CLOUD_BASE: "https://cloud.eliza.app",
      }),
    ).toThrow(/conflict|staging|production/i);
  });

  it("rejects split canonical API and renderer environments", () => {
    expect(() =>
      configureDevCloudEnvironment([], {
        ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
        VITE_ELIZA_CLOUD_BASE: "https://cloud.eliza.app",
      }),
    ).toThrow(/conflict|staging|production/i);
  });

  it("rejects unknown and missing target values", () => {
    expect(() => resolveDevCloudTarget(["--cloud-target=preview"], {})).toThrow(
      /unknown|preview/i,
    );
    expect(() => resolveDevCloudTarget(["--cloud-target"], {})).toThrow(
      /missing|expected/i,
    );
  });

  it("returns a fresh environment even when applying a resolved target directly", () => {
    const input = { CUSTOM_SENTINEL: "keep-me" };
    const configured = applyDevCloudTarget(input, {
      target: "staging",
      passthroughArgs: [],
    });

    expect(configured).toMatchObject({ ...input, ...STAGING_ENV });
    expect(configured).not.toBe(input);
    expect(input).toEqual({ CUSTOM_SENTINEL: "keep-me" });
  });
});

describe("local development entrypoint contract", () => {
  const libDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(libDir, "../../../..");
  const rootPackage = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const appPackage = JSON.parse(
    readFileSync(path.join(repoRoot, "packages/app/package.json"), "utf8"),
  );
  const orchestratorSource = readFileSync(
    path.join(repoRoot, "packages/app-core/scripts/dev-ui.mjs"),
    "utf8",
  );
  const packageDevSource = readFileSync(
    path.join(repoRoot, "packages/app/scripts/dev.mjs"),
    "utf8",
  );
  const sharedDevSource = readFileSync(
    path.join(repoRoot, "packages/app/scripts/dev-shared.mjs"),
    "utf8",
  );

  it("routes ordinary root development through the Cloud-configured orchestrator", () => {
    expect(rootPackage.scripts.dev).toContain("dev-ui.mjs");
    expect(orchestratorSource).toContain("configureDevCloudEnvironment");
  });

  it("routes direct app-package development through the same target helper", () => {
    expect(appPackage.scripts.dev).toContain("scripts/dev.mjs");
    expect(packageDevSource).toContain("configureDevCloudEnvironment");
  });

  it("routes the registered shared Vite server through the same target helper", () => {
    expect(appPackage.scripts["dev:shared"]).toContain(
      "scripts/dev-shared.mjs",
    );
    expect(sharedDevSource).toContain("configureDevCloudEnvironment");
  });
});
