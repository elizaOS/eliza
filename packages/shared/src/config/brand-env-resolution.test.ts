/** Resolves a real branded deployment through the shared facade and canonical core readers. */
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

describe("brand-env resolution for a MILADY_* prefix (no ELIZA_* mirror)", () => {
  let savedConfig: ReturnType<typeof getBootConfig>;

  beforeEach(() => {
    savedConfig = getBootConfig();
    setBootConfig({ ...savedConfig, envAliases: ALIASES });
  });

  afterEach(() => {
    setBootConfig(savedConfig);
  });

  it("resolves a complete branded deployment without mutating its environment", () => {
    const env = miladyEnv();
    const before = { ...env };
    expect(resolveAliasedEnvValue("ELIZA_STATE_DIR", ALIASES, env)).toBe(
      "/home/milady/.local/state/milady",
    );
    expect(resolveAliasedEnvValue("ELIZA_API_TOKEN", ALIASES, env)).toBe(
      "milady-secret-token",
    );
    expect(resolveRuntimePorts(env)).toEqual({
      serverOnlyPort: 4666,
      desktopApiPort: 4555,
      desktopUiPort: 4777,
    });
    expect(resolveDesktopApiPortPreference(env)).toMatchObject({
      port: 4555,
      winningKey: "MILADY_API_PORT",
    });
    expect(resolveApiSecurityConfig(env)).toEqual({
      token: "milady-secret-token",
      bindHost: "0.0.0.0",
      allowedOrigins: ["https://milady.example", "http://localhost:2138"],
      allowedHosts: ["milady.example", "localhost"],
      allowNullOrigin: true,
      disableAutoApiToken: true,
      isWildcardBind: true,
      isLoopbackBind: false,
    });
    expect(resolveApiExposePort(env)).toBe(true);
    expect(isMobilePlatform(env)).toBe(true);
    expect(isAndroidMobile(env)).toBe(true);
    expect(resolvePlatform(env)).toBe("android");
    expect(env).toEqual(before);
  });

  it("prefers an explicit canonical ELIZA_* value over the branded alias", () => {
    const env = miladyEnv();
    env.ELIZA_API_TOKEN = "canonical-wins";
    expect(resolveApiSecurityConfig(env).token).toBe("canonical-wins");
    expect(resolveAliasedEnvValue("ELIZA_API_TOKEN", ALIASES, env)).toBe(
      "canonical-wins",
    );
  });
});
