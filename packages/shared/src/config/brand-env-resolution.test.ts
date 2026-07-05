/**
 * Consolidated regression test that the whole brand-env surface resolves for a
 * non-ELIZA prefix through the alias-aware reader WITHOUT materializing the
 * `ELIZA_*` mirror (#13422). Unlike the per-slice tests that hand-author alias
 * pairs, this drives the REAL table from `buildBrandEnvAliases("MILADY")` (the
 * single source of truth) end to end — state dir, API token, ports, CORS/host
 * allow-lists, bind host, expose-port flag, and the mobile-platform flag — so a
 * suffix renamed in `brand-env-aliases.ts` that broke any consumer is caught
 * here. Deterministic; sets a MILADY_* env record and asserts no ELIZA_* key is
 * ever written. Pairs with the static `alias-read-guard.mjs` that forbids new
 * raw reads bypassing this reader.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isAndroidMobile,
  isMobilePlatform,
  resolveApiExposePort,
  resolveApiSecurityConfig,
  resolveDesktopApiPortPreference,
  resolvePlatform,
  resolveRuntimePorts,
} from "../runtime-env";
import {
  getBootConfig,
  resolveAliasedEnvValue,
  setBootConfig,
} from "./boot-config";
import { buildBrandEnvAliases } from "./brand-env-aliases";

const ALIASES = buildBrandEnvAliases("MILADY");

/** A full MILADY_* deployment env — the canonical ELIZA_* keys are all absent. */
function miladyEnv(): Record<string, string | undefined> {
  return {
    MILADY_STATE_DIR: "/home/milady/.local/state/milady",
    MILADY_API_TOKEN: "milady-secret-token",
    MILADY_API_BIND: "0.0.0.0",
    MILADY_API_EXPOSE_PORT: "true",
    MILADY_PORT: "4666",
    MILADY_API_PORT: "4555",
    MILADY_UI_PORT: "4777",
    MILADY_ALLOWED_ORIGINS: " https://milady.example, http://localhost:2138 ",
    MILADY_ALLOWED_HOSTS: " milady.example,localhost ",
    MILADY_ALLOW_NULL_ORIGIN: "true",
    MILADY_DISABLE_AUTO_API_TOKEN: "1",
    MILADY_PLATFORM: "android",
  };
}

function elizaMirrorKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((key) => key.startsWith("ELIZA_"));
}

describe("brand-env resolution for a MILADY_* prefix (no ELIZA_* mirror)", () => {
  const savedConfig = getBootConfig();

  beforeEach(() => {
    // runtime-env resolvers read the alias table from the boot config; pin it to
    // the real MILADY table so they resolve the branded keys.
    setBootConfig({ ...savedConfig, envAliases: ALIASES });
  });

  afterEach(() => {
    setBootConfig(savedConfig);
  });

  it("resolves the state dir via the reader from the branded key", () => {
    const env = miladyEnv();
    expect(resolveAliasedEnvValue("ELIZA_STATE_DIR", ALIASES, env)).toBe(
      "/home/milady/.local/state/milady",
    );
    expect(env).not.toHaveProperty("ELIZA_STATE_DIR");
  });

  it("resolves the API token via the reader and the security config", () => {
    const env = miladyEnv();
    expect(resolveAliasedEnvValue("ELIZA_API_TOKEN", ALIASES, env)).toBe(
      "milady-secret-token",
    );
    expect(resolveApiSecurityConfig(env).token).toBe("milady-secret-token");
    expect(env).not.toHaveProperty("ELIZA_API_TOKEN");
  });

  it("resolves the ports from the branded keys", () => {
    const env = miladyEnv();
    expect(resolveRuntimePorts(env)).toEqual({
      serverOnlyPort: 4666,
      desktopApiPort: 4555,
      desktopUiPort: 4777,
    });
    expect(resolveDesktopApiPortPreference(env)).toMatchObject({
      port: 4555,
      winningKey: "MILADY_API_PORT",
    });
  });

  it("resolves CORS/allowed origins, hosts, and bind host from the branded keys", () => {
    const config = resolveApiSecurityConfig(miladyEnv());
    expect(config.bindHost).toBe("0.0.0.0");
    expect(config.allowedOrigins).toEqual([
      "https://milady.example",
      "http://localhost:2138",
    ]);
    expect(config.allowedHosts).toEqual(["milady.example", "localhost"]);
    expect(config.allowNullOrigin).toBe(true);
    expect(config.disableAutoApiToken).toBe(true);
    expect(config.isWildcardBind).toBe(true);
    expect(config.isLoopbackBind).toBe(false);
  });

  it("resolves the expose-port flag from the branded key", () => {
    expect(resolveApiExposePort(miladyEnv())).toBe(true);
  });

  it("resolves the mobile-platform flag from the branded key", () => {
    const env = miladyEnv();
    expect(isMobilePlatform(env)).toBe(true);
    expect(isAndroidMobile(env)).toBe(true);
    expect(resolvePlatform(env)).toBe("android");
  });

  it("never materializes any ELIZA_* mirror while resolving the whole surface", () => {
    const env = miladyEnv();
    const before = { ...env };

    resolveAliasedEnvValue("ELIZA_STATE_DIR", ALIASES, env);
    resolveAliasedEnvValue("ELIZA_API_TOKEN", ALIASES, env);
    resolveRuntimePorts(env);
    resolveApiSecurityConfig(env);
    resolveApiExposePort(env);
    isMobilePlatform(env);
    resolvePlatform(env);

    // The reader is additive: it must not write the canonical mirror, and it
    // must not mutate the branded env record at all.
    expect(elizaMirrorKeys(env)).toEqual([]);
    expect(env).toEqual(before);
  });

  it("prefers an explicit canonical ELIZA_* value over the branded alias", () => {
    const env = miladyEnv();
    env.ELIZA_API_TOKEN = "canonical-wins";
    // A deployment that sets BOTH still gets the canonical value — the branded
    // alias never suppresses a present ELIZA_* value.
    expect(resolveApiSecurityConfig(env).token).toBe("canonical-wins");
    expect(resolveAliasedEnvValue("ELIZA_API_TOKEN", ALIASES, env)).toBe(
      "canonical-wins",
    );
  });
});
