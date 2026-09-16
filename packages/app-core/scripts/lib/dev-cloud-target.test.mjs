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
  assertRendererOnlyDevCloudTargetSupported,
  configureDevCloudEnvironment,
  resolveDevCloudTarget,
} from "./dev-cloud-target.mjs";

const STAGING_ENV = {
  ELIZA_DEV_SOURCE: "1",
  ELIZA_DEV_CLOUD_ENV_AUTHORITY: "staging-default",
  ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
  VITE_ELIZA_CLOUD_BASE: "https://cloud-staging.eliza.app",
  VITE_ELIZA_DESKTOP_RUNTIME_MODE: "cloud",
  VITE_STEWARD_API_URL: "https://staging.eliza.app/steward",
  VITE_STEWARD_TENANT_ID: "elizacloud-staging",
};

const PRODUCTION_ENV = {
  ELIZA_DEV_SOURCE: "1",
  ELIZA_DEV_CLOUD_ENV_AUTHORITY: "production",
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
      "ELIZAOS_CLOUD_USE_INFERENCE",
      "ELIZAOS_CLOUD_USE_TTS",
      "ELIZAOS_CLOUD_USE_STT",
      "ELIZAOS_CLOUD_USE_MEDIA",
      "ELIZAOS_CLOUD_USE_EMBEDDINGS",
      "ELIZAOS_CLOUD_USE_RPC",
      "ELIZA_CLOUD_API_KEY",
      "ELIZACLOUD_API_KEY",
      "ELIZA_CLOUD_PROVISIONED",
      "ELIZA_CLOUD_AGENT_ID",
      "WAIFU_ELIZA_CLOUD_AGENT_ID",
      "STEWARD_API_URL",
      "STEWARD_TENANT_ID",
      "STEWARD_AGENT_ID",
      "ELIZA_STEWARD_AGENT_ID",
      "STEWARD_API_KEY",
      "STEWARD_AGENT_TOKEN",
      "STEWARD_TRADE_SESSION_ID",
      "STEWARD_HYPERLIQUID_TRADE_SESSION_ID",
      "STEWARD_POLYMARKET_TRADE_SESSION_ID",
    ]) {
      expect(configured.env[key]).toBe("");
    }
  });

  it("selects the complete production tuple explicitly", () => {
    const configured = configureDevCloudEnvironment([], {
      ELIZA_DEV_CLOUD_TARGET: "production",
      ELIZAOS_CLOUD_API_KEY: "production-dev-key",
    });

    expect(configured.target).toBe("production");
    expect(configured.effectiveTarget).toBe("production");
    expect(configured.env).toMatchObject({
      ...PRODUCTION_ENV,
      ELIZA_DEV_CLOUD_TARGET: "production",
      ELIZAOS_CLOUD_API_KEY: "production-dev-key",
    });
    expect(configured.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
    expect(configured.env.STEWARD_API_URL).toBe("");
    expect(configured.env.STEWARD_TENANT_ID).toBe("");
  });

  it("clears inherited production Steward authority from default staging", () => {
    const configured = configureDevCloudEnvironment([], {
      STEWARD_API_URL: "https://eliza.app/steward",
      STEWARD_TENANT_ID: "elizacloud",
      STEWARD_AGENT_ID: "production-agent",
      ELIZA_STEWARD_AGENT_ID: "legacy-production-agent",
      STEWARD_API_KEY: "production-key",
      STEWARD_AGENT_TOKEN: "production-token",
      STEWARD_TRADE_SESSION_ID: "production-session",
    });

    expect(configured.env).toMatchObject(STAGING_ENV);
    for (const key of [
      "STEWARD_API_URL",
      "STEWARD_TENANT_ID",
      "STEWARD_AGENT_ID",
      "ELIZA_STEWARD_AGENT_ID",
      "STEWARD_API_KEY",
      "STEWARD_AGENT_TOKEN",
      "STEWARD_TRADE_SESSION_ID",
    ]) {
      expect(configured.env[key]).toBe("");
    }
  });

  it("scrubs ambient Steward authority from explicit staging", () => {
    const configured = configureDevCloudEnvironment([], {
      ELIZA_DEV_CLOUD_TARGET: "staging",
      STEWARD_API_URL: "https://attacker.example/steward",
      STEWARD_TENANT_ID: "attacker-tenant",
      STEWARD_AGENT_ID: "staging-agent",
      STEWARD_AGENT_TOKEN: "staging-token",
    });

    for (const key of [
      "STEWARD_API_URL",
      "STEWARD_TENANT_ID",
      "STEWARD_AGENT_ID",
      "STEWARD_AGENT_TOKEN",
    ]) {
      expect(configured.env[key]).toBe("");
    }
  });

  it("masks implicit activation and canonicalizes explicit credentials", () => {
    const inherited = {
      ELIZA_DEV_CLOUD_API_KEY: "promoted-dev-key",
      ELIZAOS_CLOUD_API_KEY: "generic-key",
      ELIZAOS_CLOUD_ENABLED: "true",
      ELIZAOS_CLOUD_USE_INFERENCE: "true",
      ELIZAOS_CLOUD_USE_TTS: "true",
      ELIZAOS_CLOUD_USE_STT: "true",
      ELIZAOS_CLOUD_USE_MEDIA: "true",
      ELIZAOS_CLOUD_USE_EMBEDDINGS: "true",
      ELIZAOS_CLOUD_USE_RPC: "true",
      ELIZA_CLOUD_API_KEY: "legacy-key",
      ELIZACLOUD_API_KEY: "older-key",
      ELIZA_CLOUD_PROVISIONED: "1",
      ELIZA_CLOUD_AGENT_ID: "prod-agent-id",
      WAIFU_ELIZA_CLOUD_AGENT_ID: "prod-agent-id-legacy",
    };

    const implicit = configureDevCloudEnvironment([], inherited);
    for (const key of Object.keys(inherited)) {
      expect(implicit.env[key]).toBe("");
    }

    const explicitStaging = configureDevCloudEnvironment([], {
      ...inherited,
      ELIZA_DEV_CLOUD_TARGET: "staging",
    });
    expect(explicitStaging.env).toMatchObject({
      ELIZA_DEV_CLOUD_ENV_AUTHORITY: "staging-explicit",
      ELIZAOS_CLOUD_API_KEY: "promoted-dev-key",
    });
    for (const key of [
      "ELIZA_DEV_CLOUD_API_KEY",
      "ELIZAOS_CLOUD_ENABLED",
      "ELIZAOS_CLOUD_USE_INFERENCE",
      "ELIZAOS_CLOUD_USE_TTS",
      "ELIZAOS_CLOUD_USE_STT",
      "ELIZAOS_CLOUD_USE_MEDIA",
      "ELIZAOS_CLOUD_USE_EMBEDDINGS",
      "ELIZAOS_CLOUD_USE_RPC",
      "ELIZA_CLOUD_API_KEY",
      "ELIZACLOUD_API_KEY",
      "ELIZA_CLOUD_PROVISIONED",
      "ELIZA_CLOUD_AGENT_ID",
      "WAIFU_ELIZA_CLOUD_AGENT_ID",
    ]) {
      expect(explicitStaging.env[key]).toBe("");
    }

    const explicitProduction = configureDevCloudEnvironment([], {
      ...inherited,
      ELIZA_DEV_CLOUD_TARGET: "production",
    });
    expect(explicitProduction.env).toMatchObject({
      ELIZA_DEV_CLOUD_ENV_AUTHORITY: "production",
      ELIZAOS_CLOUD_API_KEY: "generic-key",
      ELIZAOS_CLOUD_ENABLED: "true",
      ELIZA_CLOUD_PROVISIONED: "1",
    });
    for (const key of [
      "ELIZA_DEV_CLOUD_API_KEY",
      "ELIZA_CLOUD_API_KEY",
      "ELIZACLOUD_API_KEY",
    ]) {
      expect(explicitProduction.env[key]).toBe("");
    }
  });

  it("promotes only the staging-specific explicit credential", () => {
    const configured = configureDevCloudEnvironment([], {
      ELIZA_DEV_CLOUD_TARGET: "staging",
      ELIZA_DEV_CLOUD_API_KEY: "staging-dev-key",
    });

    expect(configured.env.ELIZAOS_CLOUD_API_KEY).toBe("staging-dev-key");
    expect(configured.env.ELIZA_DEV_CLOUD_API_KEY).toBe("");
  });

  it("rejects a production target whose only credential is staging-specific", () => {
    expect(() =>
      configureDevCloudEnvironment([], {
        ELIZA_DEV_CLOUD_TARGET: "production",
        ELIZA_DEV_CLOUD_API_KEY: "staging-only-key",
      }),
    ).toThrow(/production.*requires ELIZAOS_CLOUD_API_KEY/i);
  });

  it("ignores the staging-specific credential when selecting a production alias", () => {
    const configured = configureDevCloudEnvironment([], {
      ELIZA_DEV_CLOUD_TARGET: "production",
      ELIZA_DEV_CLOUD_API_KEY: "staging-only-key",
      ELIZA_CLOUD_API_KEY: "production-legacy-key",
    });

    expect(configured.env.ELIZAOS_CLOUD_API_KEY).toBe("production-legacy-key");
    expect(configured.env.ELIZA_DEV_CLOUD_API_KEY).toBe("");
    expect(configured.env.ELIZA_CLOUD_API_KEY).toBe("");
  });

  it.each([
    ["ELIZAOS_CLOUD_API_KEY", "generic-key"],
    ["ELIZA_CLOUD_API_KEY", "legacy-alias-key"],
    ["ELIZACLOUD_API_KEY", "oldest-alias-key"],
  ])("scrubs ambient %s from explicit staging", (key, value) => {
    const configured = configureDevCloudEnvironment([], {
      ELIZA_DEV_CLOUD_TARGET: "staging",
      [key]: value,
    });

    expect(configured.env.ELIZAOS_CLOUD_API_KEY).toBe("");
    expect(configured.env[key]).toBe("");
  });

  it.each(["[REDACTED]", "vault://dev/cloud-key"])(
    "rejects a production target whose only credential is %s",
    (placeholder) => {
      expect(() =>
        configureDevCloudEnvironment([], {
          ELIZA_DEV_CLOUD_TARGET: "production",
          ELIZAOS_CLOUD_API_KEY: placeholder,
        }),
      ).toThrow(/production.*requires ELIZAOS_CLOUD_API_KEY/i);
    },
  );

  it("skips a canonical placeholder and promotes the next usable legacy alias", () => {
    const configured = configureDevCloudEnvironment([], {
      ELIZA_DEV_CLOUD_TARGET: "production",
      ELIZAOS_CLOUD_API_KEY: "[REDACTED]",
      ELIZA_CLOUD_API_KEY: "usable-legacy-key",
    });

    expect(configured.env.ELIZAOS_CLOUD_API_KEY).toBe("usable-legacy-key");
    expect(configured.env.ELIZA_CLOUD_API_KEY).toBe("");
  });

  it("replaces same-environment wrong paths and standalone hosted overrides", () => {
    const configured = configureDevCloudEnvironment([], {
      ELIZA_DEV_CLOUD_TARGET: "staging",
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/wrong-path",
      ELIZAOS_CLOUD_BROWSER_BASE_URL:
        "https://api.eliza.app/production-browser-escape",
      ELIZAOS_CLOUD_EMBEDDING_URL:
        "https://api.eliza.app/production-embedding-escape",
      ELIZA_CLOUD_REMOTE_RUNNER_URL:
        "https://api.eliza.app/production-runner-escape",
      ELIZA_CLOUD_URL: "https://api.eliza.app/legacy-production-escape",
      VITE_ELIZA_CLOUD_BASE: "https://cloud-staging.eliza.app/wrong-path",
      VITE_STEWARD_API_URL: "https://attacker.example/steward",
      VITE_STEWARD_TENANT_ID: "attacker-tenant",
    });

    expect(configured.env).toMatchObject({
      ...STAGING_ENV,
      ELIZA_DEV_CLOUD_TARGET: "staging",
      ELIZA_DEV_CLOUD_ENV_AUTHORITY: "staging-explicit",
    });
    for (const key of [
      "ELIZAOS_CLOUD_BROWSER_BASE_URL",
      "ELIZAOS_CLOUD_EMBEDDING_URL",
      "ELIZA_CLOUD_REMOTE_RUNNER_URL",
      "ELIZA_CLOUD_URL",
    ]) {
      expect(configured.env[key]).toBe("");
    }
  });

  it("lets the CLI target override the environment and strips helper flags", () => {
    const args = ["--cloud-target", "production", "--ui-only", "--port=2200"];
    const env = {
      ELIZA_DEV_CLOUD_TARGET: "staging",
      ELIZAOS_CLOUD_API_KEY: "production-dev-key",
    };

    expect(resolveDevCloudTarget(args, env)).toEqual({
      target: "production",
      source: "cli",
      passthroughArgs: ["--ui-only", "--port=2200"],
    });
    expect(configureDevCloudEnvironment(args, env).env).toMatchObject({
      ...PRODUCTION_ENV,
      ELIZA_DEV_CLOUD_TARGET: "production",
      ELIZAOS_CLOUD_API_KEY: "production-dev-key",
    });
  });

  it("fails production startup before serving a keyless loopback login flow", () => {
    expect(() =>
      configureDevCloudEnvironment([], {
        ELIZA_DEV_CLOUD_TARGET: "production",
      }),
    ).toThrow(/production.*requires ELIZAOS_CLOUD_API_KEY/i);
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
      ELIZA_CLOUD_AGENT_ID: "prod-agent-id-must-not-reach-local-agent",
      WAIFU_ELIZA_CLOUD_AGENT_ID:
        "prod-agent-id-legacy-must-not-reach-local-agent",
      PRESERVED_LOCAL_SETTING: "yes",
    };
    const configured = configureDevCloudEnvironment([], input);

    expect(configured.target).toBe("offline");
    expect(configured.effectiveTarget).toBe("offline");
    expect(configured.env).toMatchObject({
      ELIZA_DEV_SOURCE: "1",
      ELIZA_DEV_CLOUD_TARGET: "offline",
      ELIZA_DEV_CLOUD_ENV_AUTHORITY: "offline",
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
      "ELIZAOS_CLOUD_USE_INFERENCE",
      "ELIZAOS_CLOUD_USE_TTS",
      "ELIZAOS_CLOUD_USE_STT",
      "ELIZAOS_CLOUD_USE_MEDIA",
      "ELIZAOS_CLOUD_USE_EMBEDDINGS",
      "ELIZAOS_CLOUD_USE_RPC",
      "ELIZA_CLOUD_API_KEY",
      "ELIZACLOUD_API_KEY",
      "ELIZA_CLOUD_PROVISIONED",
      "ELIZA_CLOUD_AGENT_ID",
      "WAIFU_ELIZA_CLOUD_AGENT_ID",
      "VITE_ELIZA_DESKTOP_RUNTIME_MODE",
      "STEWARD_API_URL",
      "STEWARD_TENANT_ID",
      "STEWARD_AGENT_ID",
      "ELIZA_STEWARD_AGENT_ID",
      "STEWARD_API_KEY",
      "STEWARD_AGENT_TOKEN",
      "STEWARD_TRADE_SESSION_ID",
      "STEWARD_HYPERLIQUID_TRADE_SESSION_ID",
      "STEWARD_POLYMARKET_TRADE_SESSION_ID",
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
      ELIZAOS_CLOUD_BASE_URL: input.ELIZAOS_CLOUD_BASE_URL,
      VITE_ELIZA_CLOUD_BASE: input.VITE_ELIZA_CLOUD_BASE,
      VITE_ELIZA_DESKTOP_RUNTIME_MODE: input.VITE_ELIZA_DESKTOP_RUNTIME_MODE,
      VITE_STEWARD_API_URL: input.VITE_STEWARD_API_URL,
      VITE_STEWARD_TENANT_ID: input.VITE_STEWARD_TENANT_ID,
      CUSTOM_SENTINEL: input.CUSTOM_SENTINEL,
      ELIZA_DEV_SOURCE: "1",
      ELIZA_DEV_CLOUD_ENV_AUTHORITY: "self-hosted",
      ELIZAOS_CLOUD_API_KEY: "private-dev-key",
      ELIZA_DEV_CLOUD_API_KEY: "",
    });
    expect(input).toEqual(snapshot);
    expect(configured.env).not.toBe(input);
  });

  it("allows an optional /api/v1 suffix for one self-hosted surface", () => {
    const configured = configureDevCloudEnvironment([], {
      ELIZAOS_CLOUD_BASE_URL: "https://private.example/api/v1/",
      VITE_ELIZA_CLOUD_BASE: "https://private.example/",
      ELIZAOS_CLOUD_API_KEY: "private-key",
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
      ELIZAOS_CLOUD_API_KEY: "private-key",
    });
    const withTenant = configureDevCloudEnvironment([], {
      ELIZAOS_CLOUD_BASE_URL: "https://private.example",
      VITE_ELIZA_CLOUD_BASE: "https://private.example",
      VITE_STEWARD_TENANT_ID: "private-tenant",
      ELIZAOS_CLOUD_API_KEY: "private-key",
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

  it("allows the API and renderer to use separate self-hosted surfaces", () => {
    const configured = configureDevCloudEnvironment([], {
      ELIZAOS_CLOUD_BASE_URL: "https://api.private.example/api/v1",
      VITE_ELIZA_CLOUD_BASE: "https://app.private.example",
      ELIZAOS_CLOUD_API_KEY: "private-key",
    });

    expect(configured.effectiveTarget).toBe("self-hosted");
    expect(configured.env).toMatchObject({
      ELIZA_DEV_CLOUD_ENV_AUTHORITY: "self-hosted",
      ELIZAOS_CLOUD_BASE_URL: "https://api.private.example/api/v1",
      ELIZAOS_CLOUD_API_KEY: "private-key",
      VITE_ELIZA_CLOUD_BASE: "https://app.private.example",
    });
  });

  it("fails self-hosted startup before serving a keyless proxy login flow", () => {
    expect(() =>
      configureDevCloudEnvironment([], {
        ELIZAOS_CLOUD_BASE_URL: "https://api.private.example/api/v1",
        VITE_ELIZA_CLOUD_BASE: "https://app.private.example",
      }),
    ).toThrow(/self-hosted.*requires ELIZAOS_CLOUD_API_KEY/i);
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
      ELIZA_DEV_CLOUD_ENV_AUTHORITY: "offline",
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
      source: "default",
      passthroughArgs: [],
    });

    expect(configured).toMatchObject({ ...input, ...STAGING_ENV });
    expect(configured).not.toBe(input);
    expect(input).toEqual({ CUSTOM_SENTINEL: "keep-me" });
  });

  it("keeps renderer-only development on targets that can authenticate without a server credential", () => {
    for (const configured of [
      configureDevCloudEnvironment([], {}),
      configureDevCloudEnvironment(["--cloud-target=staging"], {}),
      configureDevCloudEnvironment(["--cloud-target=offline"], {}),
    ]) {
      expect(() =>
        assertRendererOnlyDevCloudTargetSupported(configured, "test renderer"),
      ).not.toThrow();
    }
  });

  it("rejects production and self-hosted targets before a renderer-only entrypoint starts Vite", () => {
    const production = configureDevCloudEnvironment(
      ["--cloud-target=production"],
      { ELIZAOS_CLOUD_API_KEY: "production-launch-key" },
    );
    const selfHosted = configureDevCloudEnvironment([], {
      ELIZAOS_CLOUD_BASE_URL: "https://api.private.example/api/v1",
      ELIZAOS_CLOUD_API_KEY: "self-hosted-launch-key",
      VITE_ELIZA_CLOUD_BASE: "https://app.private.example",
    });

    for (const configured of [production, selfHosted]) {
      expect(() =>
        assertRendererOnlyDevCloudTargetSupported(configured, "test renderer"),
      ).toThrow(/cannot use Cloud target.*without a local agent backend/i);
    }
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
  const desktopDevSource = readFileSync(
    path.join(repoRoot, "packages/app-core/scripts/dev-platform.mjs"),
    "utf8",
  );

  it("routes ordinary root development through the Cloud-configured orchestrator", () => {
    expect(rootPackage.scripts.dev).toContain("dev-ui.mjs");
    expect(orchestratorSource).toContain("configureDevCloudEnvironment");
  });

  it("routes direct app-package development through the same target helper", () => {
    expect(appPackage.scripts.dev).toContain("scripts/dev.mjs");
    expect(packageDevSource).toContain("configureDevCloudEnvironment");
    expect(packageDevSource).toContain(
      "assertRendererOnlyDevCloudTargetSupported(devCloud",
    );
    expect(
      packageDevSource.indexOf(
        "assertRendererOnlyDevCloudTargetSupported(devCloud",
      ),
    ).toBeLessThan(packageDevSource.indexOf("spawnMirroredChild("));
  });

  it("routes the registered shared Vite server through the same target helper", () => {
    expect(appPackage.scripts["dev:shared"]).toContain(
      "scripts/dev-shared.mjs",
    );
    expect(sharedDevSource).toContain("configureDevCloudEnvironment");
    expect(sharedDevSource).toContain(
      "assertRendererOnlyDevCloudTargetSupported(devCloud",
    );
    expect(
      sharedDevSource.indexOf(
        "assertRendererOnlyDevCloudTargetSupported(devCloud",
      ),
    ).toBeLessThan(sharedDevSource.indexOf("reservePortsForWorktree("));
  });

  it("routes native desktop development through the same target helper", () => {
    expect(rootPackage.scripts["dev:desktop"]).toContain("dev-platform.mjs");
    expect(rootPackage.scripts["dev:desktop:watch"]).toContain(
      "dev-platform.mjs",
    );
    expect(desktopDevSource).toContain("configureDevCloudEnvironment");
    expect(desktopDevSource).toContain("devCloud.passthroughArgs");
  });
});
