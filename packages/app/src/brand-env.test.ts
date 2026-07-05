/**
 * Brand env alias coverage for runtime boot settings. White-label builds must
 * expose every API/security/port key that the shared runtime env resolvers can
 * read alias-aware, otherwise tests can pass with aliases the real app never
 * installs into BootConfig.
 */
import { describe, expect, it } from "vitest";
import { buildBrandEnvAliases } from "./brand-env";

describe("buildBrandEnvAliases", () => {
  it("covers runtime API security and port aliases", () => {
    const aliases = new Map(buildBrandEnvAliases("ACME"));

    expect(aliases.get("ACME_API_BIND")).toBe("ELIZA_API_BIND");
    expect(aliases.get("ACME_API_TOKEN")).toBe("ELIZA_API_TOKEN");
    expect(aliases.get("ACME_API_EXPOSE_PORT")).toBe("ELIZA_API_EXPOSE_PORT");
    expect(aliases.get("ACME_ALLOWED_ORIGINS")).toBe("ELIZA_ALLOWED_ORIGINS");
    expect(aliases.get("ACME_ALLOWED_HOSTS")).toBe("ELIZA_ALLOWED_HOSTS");
    expect(aliases.get("ACME_ALLOW_NULL_ORIGIN")).toBe(
      "ELIZA_ALLOW_NULL_ORIGIN",
    );
    expect(aliases.get("ACME_DISABLE_AUTO_API_TOKEN")).toBe(
      "ELIZA_DISABLE_AUTO_API_TOKEN",
    );
    expect(aliases.get("ACME_WALLET_EXPORT_TOKEN")).toBe(
      "ELIZA_WALLET_EXPORT_TOKEN",
    );
    expect(aliases.get("ACME_TERMINAL_RUN_TOKEN")).toBe(
      "ELIZA_TERMINAL_RUN_TOKEN",
    );
    expect(aliases.get("ACME_PORT")).toBe("ELIZA_PORT");
    expect(aliases.get("ACME_UI_PORT")).toBe("ELIZA_UI_PORT");
    expect(aliases.get("ACME_API_PORT")).toBe("ELIZA_API_PORT");
    expect(aliases.get("ACME_PLATFORM")).toBe("ELIZA_PLATFORM");
  });

  it("covers aliases formerly present only in the sync mutation table", () => {
    const aliases = new Map(buildBrandEnvAliases("ACME"));

    expect(aliases.get("ACME_OAUTH_DIR")).toBe("ELIZA_OAUTH_DIR");
    expect(aliases.get("ACME_AGENT_ORCHESTRATOR")).toBe(
      "ELIZA_AGENT_ORCHESTRATOR",
    );
    expect(aliases.get("ACME_CLOUD_PROVISIONED")).toBe(
      "ELIZA_CLOUD_PROVISIONED",
    );
    expect(aliases.get("ACME_CLOUD_MANAGED_AGENTS_API_SEGMENT")).toBe(
      "ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT",
    );
    expect(aliases.get("ACME_CHAT_GENERATION_TIMEOUT_MS")).toBe(
      "ELIZA_CHAT_GENERATION_TIMEOUT_MS",
    );
    expect(aliases.get("ACME_SKIP_LOCAL_PLUGIN_ROLES")).toBe(
      "ELIZA_SKIP_LOCAL_PLUGIN_ROLES",
    );
    expect(aliases.get("ACME_SETTINGS_DEBUG")).toBe("ELIZA_SETTINGS_DEBUG");
    expect(aliases.get("VITE_ACME_SETTINGS_DEBUG")).toBe(
      "VITE_ELIZA_SETTINGS_DEBUG",
    );
    expect(aliases.get("ACME_GOOGLE_OAUTH_DESKTOP_CLIENT_ID")).toBe(
      "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
    );
    expect(aliases.get("ACME_API_BASE")).toBe("ELIZA_API_BASE");
    expect(aliases.get("ACME_API_BASE_URL")).toBe("ELIZA_API_BASE_URL");
    expect(aliases.get("ACME_DESKTOP_API_BASE")).toBe("ELIZA_DESKTOP_API_BASE");
    expect(aliases.get("ACME_DESKTOP_TEST_API_BASE")).toBe(
      "ELIZA_DESKTOP_TEST_API_BASE",
    );
    expect(aliases.get("ACME_DESKTOP_SKIP_EMBEDDED_AGENT")).toBe(
      "ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT",
    );
    expect(aliases.get("ACME_RENDERER_URL")).toBe("ELIZA_RENDERER_URL");
    expect(aliases.get("ACME_APP_ROUTE_PLUGIN_MODULES")).toBe(
      "ELIZA_APP_ROUTE_PLUGIN_MODULES",
    );
  });
});
