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
    expect(aliases.get("ACME_PORT")).toBe("ELIZA_PORT");
    expect(aliases.get("ACME_UI_PORT")).toBe("ELIZA_UI_PORT");
    expect(aliases.get("ACME_API_PORT")).toBe("ELIZA_API_PORT");
    expect(aliases.get("ACME_PLATFORM")).toBe("ELIZA_PLATFORM");
  });
});
